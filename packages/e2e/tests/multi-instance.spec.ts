import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorApp, installTermsAccepted, readZipEntryText } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 多重起動 (#435): 同じ BrowserContext の 2 つのタブで同じモードを開くと、後から開いた側が
 * `SingleInstanceGuard` (Web Locks `typedcode-instance-guard:<mode>` を `ifAvailable` で求め、取れなければ
 * 既存あり。#494) で止まり `[data-dialog="duplicate-instance"]` を出す。ロックはモード別なので、別のモードなら
 * 両方とも編集できる。
 *
 * 2 ページ目は `?reset` を付けずに開く (付けると 1 ページ目が開いている DB まで消しに行く)。
 */

test('同じモードを 2 つのタブで開くと、後から開いた側に duplicate-instance が出る', async ({ page, context }) => {
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await expect.poll(() => first.appState()).toBe('ready');

  const page2 = await context.newPage();
  const second = new EditorApp(page2);
  await page2.goto('/casual');

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  // 後から開いた側は編集に進まない。先に開いた側は影響を受けない。
  expect(await second.appState()).toBe('initializing');
  expect(await first.openDialogs()).not.toContain('duplicate-instance');
  await first.typeCode('int a = 1;\n');
  await first.expectConsistent();
});

test('別のモード (casual と assignment) なら、2 つのタブの両方で編集できる', async ({ page, context }) => {
  const casual = new EditorApp(page);
  await casual.openCasualFresh();
  await expect.poll(() => casual.appState()).toBe('ready');

  const page2 = await context.newPage();
  const assignment = new EditorApp(page2);
  await installTermsAccepted(page2);
  await page2.goto('/assignment');
  // assignment は起動時にタブを作らない (ウェルカム画面)。新規ファイルで始める。
  await expect.poll(() => assignment.openDialogs(), { timeout: 30_000 }).toContain('welcome');
  expect(await assignment.openDialogs()).not.toContain('duplicate-instance');
  await page2.locator('#welcome-new-file').click();
  await expect.poll(() => assignment.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);

  await assignment.typeCode('int b = 2;');
  await assignment.expectConsistent();
  expect((await assignment.snapshot()).tabs.map((t) => t.content)).toEqual(['int b = 2;']);

  await casual.typeCode('int a = 1;');
  await casual.expectConsistent();
  expect((await casual.snapshot()).tabs.map((t) => t.content)).toEqual(['int a = 1;']);
  expect(await casual.openDialogs()).not.toContain('duplicate-instance');
});

/**
 * #483: 離脱確認 (beforeunload) で「このページに留まる」を選ぶと、アンロードは起きないのにガードが
 * 破棄され、2 つ目のタブが正規インスタンスとして起動できてしまった。破棄は pagehide (persisted=false)
 * に移したので、留まったページのガードは生きている。
 * 離脱確認は記録のあるタブ (events > 0) を閉じようとしたときに出る (`beforeUnloadGuard.ts`)。
 */
test('離脱確認で「留まる」を選んだ後に同じモードを開くと、後から開いた側が duplicate-instance で止まる (#483)', async ({
  page,
  context,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await first.typeCode('int a = 1;\n');
  await first.waitForSynced();

  await page.close({ runBeforeUnload: true });
  // close() はダイアログの処理を待たずに返るので、出るのを待つ。dismiss したのでタブは閉じない。
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);

  const page2 = await context.newPage();
  const second = new EditorApp(page2);
  await page2.goto('/casual');

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  expect(await second.appState()).toBe('initializing');
  // 留まったページはそのまま編集を続けられ、チェーンも整合している。
  await first.typeCode('int b = 2;\n');
  await first.expectConsistent();
});

/**
 * #494: 同じモードで ready のページから `window.open` で開いたページ (opener を持つ popup) も、
 * `duplicate-instance` で止まる。popup は開いた側と同じ renderer の main thread で動くので、
 * 開かれた側の初期化の長いタスクの間は開いた側が ping に答えられず、pong の待ち時間 (500ms) が
 * 先に切れてガードをすり抜け、復旧ダイアログ (`session-recovery`) で止まっていた。判定を時間に
 * 依存しない Web Locks に移して直した。
 */
test('window.open で開いた同じモードのページも duplicate-instance で止まり、開いた側の記録は変わらない (#494)', async ({
  page,
}) => {
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await first.typeCode('int a = 1;\n');
  await first.waitForSynced();
  const tabsOf = async (app: EditorApp) =>
    (await app.snapshot()).tabs.map((t) => ({ id: t.id, filename: t.filename, content: t.content }));
  const before = await tabsOf(first);

  const popupP = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.open('/casual', '_blank');
  });
  const second = new EditorApp(await popupP);

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  expect(await second.openDialogs()).not.toContain('session-recovery');
  expect(await second.appState()).toBe('initializing');

  // 開いた側はタブ構成も記録もそのままで、続けて書いた分も含めて export が検証を通る。
  await page.bringToFront();
  expect(await first.openDialogs()).not.toContain('duplicate-instance');
  expect(await tabsOf(first)).toEqual(before);
  await first.typeCode('int b = 2;\n');
  await first.expectConsistent();
  await first.waitForSynced();
  const zipPath = await first.exportAllTabs();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

/**
 * #237: ガードをすり抜けた二重インスタンスでは、セッションを後から再開された側 (凍結を解かれて戻ってきた側) が譲る。
 *
 * すり抜けは Web Locks を使えない経路 (ping → pong) でだけ起きる。凍結中のタブは pong を返せないが、CDP の
 * freeze は本物のタブ凍結の再現にならない (#237 の 11-04 コメント) ので、ここでは 2 つ目のページから
 * `navigator.locks` を外し、届いた pong を捨てて「既存のタブが答えなかった」状態を作る。2 つ目のページが
 * 復旧ダイアログで「再開」すると sessions 行の所有者が 2 つ目に移り、1 つ目は heartbeat を受けて所有者を確かめ、
 * 読み取り専用になって `instance-conflict` の画面と救出ボタンを出す。2 つ目の記録は続く。
 * 実ブラウザのタブ凍結 (`chrome://discards` の Freeze) での確認は手動。
 */
test('ガードをすり抜けた 2 つ目のタブが再開すると、1 つ目が instance-conflict で読み取り専用になり、2 つ目の記録は続く (#237)', async ({
  page,
  context,
}) => {
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await first.typeCode('int a = 1;\n');
  await first.waitForSynced();

  const page2 = await context.newPage();
  await page2.addInitScript(() => {
    // Web Locks の無い環境 (ping → pong に戻る) にする
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
    // 既存のタブが凍結中で pong を返さなかったことにする
    const add = BroadcastChannel.prototype.addEventListener;
    BroadcastChannel.prototype.addEventListener = function (
      this: BroadcastChannel,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (type !== 'message' || typeof listener !== 'function') {
        add.call(this, type, listener, options);
        return;
      }
      const filtered = (event: Event): void => {
        if (((event as MessageEvent).data as { type?: string } | null)?.type === 'pong') return;
        listener.call(this, event);
      };
      add.call(this, type, filtered, options);
    } as typeof BroadcastChannel.prototype.addEventListener;
  });
  const second = new EditorApp(page2);
  await page2.goto('/casual');
  // すり抜けた 2 つ目は duplicate-instance で止まらず、復旧ダイアログで前のセッションを再開する
  await page2.locator('#session-resume-btn').click({ timeout: 30_000 });
  await second.waitReady();

  // 1 つ目 (セッションを再開された側) が譲る
  await expect.poll(() => first.openDialogs(), { timeout: 15_000 }).toContain('instance-conflict');
  expect(await second.openDialogs()).not.toContain('instance-conflict');

  // 2 つ目の記録は続き、表示と記録が整合している
  const before = await second.eventCount();
  await second.typeCode('int b = 2;\n');
  await expect.poll(() => second.eventCount()).toBeGreaterThan(before);
  await second.expectConsistent();
  await second.waitForSynced();
  expect(await second.openDialogs()).not.toContain('instance-conflict');

  // 1 つ目はその時点のコードを救出できる (救出ファイルは証明ではない)。救出しても画面は閉じない
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-dialog="instance-conflict"] [data-action="rescue"]').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^RESCUE_TC\d{10}\.zip$/);
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-conflict-')), file.suggestedFilename());
  await file.saveAs(dest);
  const manifest = JSON.parse(await readZipEntryText(dest, 'rescue-manifest.json')) as {
    notAProof: boolean;
    tabs: Array<{ source?: string }>;
  };
  expect(manifest.notAProof).toBe(true);
  expect(await readZipEntryText(dest, manifest.tabs[0]!.source!)).toBe((await first.snapshot()).tabs[0]!.content);
  expect(await first.openDialogs()).toContain('instance-conflict');
});
