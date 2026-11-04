import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  EditorApp,
  appendToStoredTabContent,
  listZipEntries,
  readProofEvents,
  readProofJson,
  readUnprovenContents,
  readZipEntryText,
} from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * タブ閉じ復旧 (#130 回帰): ブラウザタブを閉じると sessionStorage は消えるが IndexedDB は
 * 残る。再訪時に SessionRecoveryDialog から「再開」した場合も sessionStartToken (ADR-0017)
 * が引き継がれ、アンカー済みセッションの proof が root 不一致にならず検証が pass する。
 * リロード復元 (sessionStorage 経路 = reload-recovery.spec) と対になる IndexedDB 経路のテスト。
 *
 * 検証は `--mode fast`: #130 の破綻は root (initial event chain hash) 不一致であり
 * PoSW 再計算とは無関係なので fast で検出できる (CI 時間の節約)。
 */
test('タブを閉じて復旧ダイアログから再開しても root アンカーが保持され検証が pass する', async ({ page, context }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();

  // ブラウザタブを閉じる = sessionStorage 消滅・IndexedDB は残る。
  await page.close();

  // 再訪 (?reset なし)。sessionStorage が無いので SessionRecoveryDialog が出るはず。
  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');

  // この経路では復旧ダイアログの出現自体がテストの前提 (出なければ復旧経路を通っていない)。
  const resume = page2.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();

  await page2.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
  await expect.poll(() => app2.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);

  // 復元されたエディタに前回の内容が残っている。
  expect(await app2.editorValue()).toContain('int a = 1;');

  // 復旧後にさらに打鍵してチェーンを伸ばし、export する。
  await app2.typeCode('int b = 2;\n');
  await app2.waitForSynced();
  const zipPath = await app2.exportCurrentTab();

  // #130 の核心: アンカー済みセッションの token が IndexedDB 復旧をまたいで proof に残る。
  const proof = await readProofJson(zipPath);
  expect(proof.rootAnchored, 'sessionStartToken must survive IndexedDB recovery').toBe(true);
  expect(proof.sessionStartToken, 'proof must carry the session start token').toBeTruthy();

  // チェーンは復旧をまたいでも valid (root 不一致なら fast でも即 fail する)。
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');

  // sessionResumed イベントが記録されている (復旧の痕跡)。
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(true);
});

/**
 * #322: tabs レコードの currentHash が古い値に戻った状態 (定期保存と append の競合の産物) で
 * 再開しても、復元は events 末尾の hash からチェーンを続けるので検証が pass する。
 *
 * 書き換えは必ず**閉じた後**に、session DB を書かない入口 (`/`) の別ページから行う。閉じる前に
 * 書き換えると、閉じる時の visibility イベントの append が値を進めてしまい決定的にならない。
 */
test('tabs レコードの currentHash が古くても、再開後のチェーンは切れず検証が pass する (#322)', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();
  await page.close();

  // 同じ origin の入口から tabs レコードの currentHash を events 先頭の hash に巻き戻す。
  const landing = await context.newPage();
  await landing.goto('/');
  const rewound = await landing.evaluate(
    () =>
      new Promise<{ stale: string; last: string }>((resolve, reject) => {
        const open = indexedDB.open('typedcode-session');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['tabs', 'events'], 'readwrite');
          const tabsReq = tx.objectStore('tabs').getAll();
          const eventsReq = tx.objectStore('events').getAll();
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
          let pending = 2;
          const done = () => {
            if (--pending > 0) return;
            const tab = (tabsReq.result as Array<{ currentHash: string }>)[0];
            const events = (eventsReq.result as Array<{ eventIndex: number; eventData: { hash: string } }>).sort(
              (a, b) => a.eventIndex - b.eventIndex
            );
            if (!tab || events.length < 2) {
              reject(new Error(`unexpected session DB: tabs=${tabsReq.result.length} events=${events.length}`));
              return;
            }
            const stale = events[0]!.eventData.hash;
            const last = events[events.length - 1]!.eventData.hash;
            tab.currentHash = stale;
            tx.objectStore('tabs').put(tab);
            resolve({ stale, last });
          };
          tabsReq.onsuccess = done;
          eventsReq.onsuccess = done;
        };
      })
  );
  expect(rewound.stale, 'precondition: the rewound hash must differ from the chain tail').not.toBe(rewound.last);
  await landing.close();

  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  const resume = page2.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();

  await page2.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
  await expect.poll(() => app2.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await app2.editorValue()).toContain('int a = 1;');

  await app2.typeCode('int b = 2;\n');
  await app2.waitForSynced();
  const zipPath = await app2.exportCurrentTab();

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});

/**
 * #413: PoSW の処理待ちが残ったまま閉じた状態 (打鍵は tabs の content にだけ残り、チェーンに載っていない) を作る。
 * 打鍵して保存を待ってから閉じ、`/` の別ページから tabs の content の末尾に `PENDING_SUFFIX` を足す。
 * 返り値は書き換える前 (= チェーンの replay と一致する版) と後の content。
 */
const PENDING_SUFFIX = 'PENDING_EDIT();';

async function closeWithUnprovenEdit(page: Page, context: BrowserContext): Promise<{ before: string; after: string }> {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();
  await page.close();

  const landing = await context.newPage();
  await landing.goto('/');
  const rewritten = await appendToStoredTabContent(landing, PENDING_SUFFIX);
  await landing.close();
  return rewritten;
}

/** 新しいページで `/casual` を開き、復旧ダイアログから再開する */
async function resumeInNewPage(context: BrowserContext): Promise<EditorApp> {
  const page = await context.newPage();
  const app = new EditorApp(page);
  await page.goto('/casual');
  const resume = page.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();
  await app.waitReady();
  return app;
}

const unprovenDialog = (page: Page) => page.locator('[data-dialog="unproven-content"]');

async function closeUnprovenDialog(page: Page): Promise<void> {
  await unprovenDialog(page).locator('.modal-footer .modal-btn-primary').click();
  await expect(unprovenDialog(page)).toHaveCount(0);
}

test('#413 処理待ちを残して閉じた後に再開すると、バッファは証明の版になり、元との差分を知らせ、そのまま export して検証が pass する', async ({
  page,
  context,
}) => {
  const { before, after } = await closeWithUnprovenEdit(page, context);
  const app = await resumeInNewPage(context);

  // バッファは replay 版 (書き換える前の content) で、足した末尾は入っていない
  const [tab] = (await app.snapshot()).tabs;
  expect(tab?.content).toBe(before);

  // 通知が出て、元 (after) と証明 (before) の文字数を出す。差 = 足した文字数
  const row = unprovenDialog(app.page).locator('.unproven-item');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-tab-id', tab!.id);
  await expect(row).toHaveAttribute('data-original-length', String(after.length));
  await expect(row).toHaveAttribute('data-chain-length', String(before.length));
  expect(after.length - before.length).toBe(PENDING_SUFFIX.length);

  await closeUnprovenDialog(app.page);

  // そのまま export すると verify-cli で PASS する (バッファが証明と一致している)
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});

test('#413 通知から、元のコードとの差分を読み取り専用で開き、元のコードをダウンロードできる', async ({
  page,
  context,
}) => {
  const { after } = await closeWithUnprovenEdit(page, context);
  const app = await resumeInNewPage(context);
  const dialog = unprovenDialog(app.page);
  const [tab] = (await app.snapshot()).tabs;

  // 差分: 右 (modified) が元のコード。打っても内容が変わらない (読み取り専用)
  await dialog.locator('[data-action="show-diff"]').click();
  const diff = dialog.locator('.unproven-diff');
  await expect(diff).toHaveAttribute('data-diff-tab-id', tab!.id);
  // 削除行の view zone も .view-lines を持つので、本文の行 (line-delete でない方) を読む
  const modified = diff.locator('.monaco-diff-editor .editor.modified .view-lines:not(.line-delete)');
  await expect(modified).toContainText(PENDING_SUFFIX);
  await modified.click();
  await app.page.keyboard.type('ZZZ');
  await expect(modified).not.toContainText('ZZZ');
  // エディタの本体も変わっていない (差分の入力がバッファや記録に漏れない)
  expect((await app.snapshot()).tabs[0]?.content).toBe(tab!.content);

  // ダウンロード: 中身は書き換えた content (元のコード) と一致する
  const downloading = app.page.waitForEvent('download', { timeout: 30_000 });
  await dialog.locator('[data-action="download"]').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^UNPROVEN_/);
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-unproven-')), download.suggestedFilename());
  await download.saveAs(dest);
  expect(await readFile(dest, 'utf8')).toBe(after);
});

test('#413 保全した元のコードは、打鍵を続けて保存しても、リロードしても上書きも削除もされず、救出 ZIP の src/ とは別の場所に入る', async ({
  page,
  context,
}) => {
  const { before, after } = await closeWithUnprovenEdit(page, context);
  const app = await resumeInNewPage(context);
  await closeUnprovenDialog(app.page);
  const [tab] = (await app.snapshot()).tabs;
  const preserved = [{ tabId: tab!.id, content: after, chainContentLength: before.length }];

  expect(await readUnprovenContents(app.page)).toEqual(preserved);

  // 打鍵を続けて保存する (tabs の content は新しい内容で put される)
  await app.typeCode('int b = 2;');
  await app.waitForSynced();
  expect(await readUnprovenContents(app.page)).toEqual(preserved);

  // リロード (sessionStorage からの復元)。replay は合うので通知は出し直さず、元のコードは残る
  await app.reloadAndResume();
  await expect(app.page.locator('html')).toHaveAttribute('data-app-state', 'ready');
  expect(await readUnprovenContents(app.page)).toEqual(preserved);
  expect(await app.openDialogs()).not.toContain('unproven-content');

  // 救出 ZIP: 元のコードは src/ とは別の場所 (unproven/) に入り、manifest に文字数が載る
  const downloading = app.page.waitForEvent('download', { timeout: 30_000 });
  await app.page.locator('#download-menu-btn').click();
  await app.page.locator('#rescue-download-btn').click();
  const rescue = await downloading;
  const zipPath = join(mkdtempSync(join(tmpdir(), 'tc-e2e-rescue-')), rescue.suggestedFilename());
  await rescue.saveAs(zipPath);

  const manifest = JSON.parse(await readZipEntryText(zipPath, 'rescue-manifest.json')) as {
    schema: string;
    tabs: {
      id: string;
      source: string;
      unprovenContents: { path: string; originalLength: number; chainContentLength: number }[];
    }[];
  };
  expect(manifest.schema).toBe('typedcode-rescue/2');
  const [rescuedTab] = manifest.tabs;
  expect(rescuedTab?.unprovenContents).toEqual([
    { path: expect.stringMatching(/^unproven\//), originalLength: after.length, chainContentLength: before.length },
  ]);
  const unprovenPath = rescuedTab!.unprovenContents[0]!.path;
  expect(await listZipEntries(zipPath)).toContain(unprovenPath);
  expect(await readZipEntryText(zipPath, unprovenPath)).toBe(after);
  expect(await readZipEntryText(zipPath, rescuedTab!.source)).toContain('int b = 2;');
});
