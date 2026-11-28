import { test, expect, type Page } from '@playwright/test';
import { CASUAL_SESSION_DB, EditorApp, NEUTRAL_PATH, readProofEvents } from './helpers/app.js';
import { allPassed, runVerifyCliWithResult } from './helpers/verifyCli.js';

/**
 * #878: 保存済みのイベント列に sequence の飛びがあるまま復元すると、以前は飛びをまたいだ記録のまま続き、
 * export した proof が検証に通らなかった (利用者には console にしか出ない)。いまは記録を飛びの手前で
 * 切り詰め、その後のコードと飛びより後のイベントを #413 と同じ `unprovenContents` に保全して、同じ通知
 * (`unproven-content`) で `data-reason="sequence-gap"` として知らせる。切り詰めた記録の続きを、そのタブで
 * 記録して export できる (ADR-0058)。
 *
 * 飛びは、閉じた後に session DB の events から 1 行を消して作る (保存の失敗・古い版の DB の再現)。書き換えは
 * 必ず閉じた後 (または読み直しの直前) に行う。開いている間に書き換えると、保存が行を戻しうる。
 *
 * 飛びより後の checkpoint の署名は proof から外れるので、切り詰めた後の署名はサーバの index と食い違い
 * (409)、以後の checkpoint は未署名のまま export される (#878 の判断 2。署名の再開は別 Issue)。それでも
 * proof は検証を通ることを、export を 1 回挟んで署名済みの checkpoint を飛びの先に作って確かめる。
 *
 * 検証は `--mode fast` (確かめるのはチェーンと content の replay で、PoSW の再計算は要らない)。
 */

const FIRST = 'int a = 1;\n';
const SECOND = 'int b = 2;\n';

/** 飛びを作る前に保存されていたイベントの hash (添字 = eventIndex。消した行も含む) */
type StoredHashes = string[];

/** タブ 1 本の session DB で、`eventIndex` の行を消す (飛びを作る)。消す前の全行の hash を返す */
function removeStoredEvent(page: Page, eventIndex: number): Promise<StoredHashes> {
  return page.evaluate(
    ({ dbName, eventIndex }) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['events'], 'readwrite');
          const store = tx.objectStore('events');
          const all = store.getAll();
          let hashes: string[] = [];
          all.onsuccess = () => {
            const rows = (all.result as Array<{ id: number; eventIndex: number; eventData: { hash: string } }>).sort(
              (a, b) => a.eventIndex - b.eventIndex
            );
            const target = rows.find((row) => row.eventIndex === eventIndex);
            const max = rows[rows.length - 1]?.eventIndex ?? -1;
            hashes = rows.map((row) => row.eventData.hash);
            if (!target || max <= eventIndex || rows.some((row, i) => row.eventIndex !== i)) {
              reject(new Error(`no event row after ${eventIndex} to make a gap (max ${max})`));
              tx.abort();
              return;
            }
            store.delete(target.id);
          };
          tx.oncomplete = () => {
            db.close();
            resolve(hashes);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { dbName: CASUAL_SESSION_DB, eventIndex }
  );
}

interface StoredRecord {
  eventIndexes: number[];
  tabContent: string;
  unproven: { reason?: string; content: string; chainContentLength: number; truncatedSequences: number[] }[];
}

/** session DB の events の eventIndex (昇順)・tabs の content・保全した元のコード */
function readStoredRecord(page: Page): Promise<StoredRecord> {
  return page.evaluate(
    (dbName) =>
      new Promise<StoredRecord>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['events', 'tabs', 'unprovenContents'], 'readonly');
          const events = tx.objectStore('events').getAll();
          const tabs = tx.objectStore('tabs').getAll();
          const unproven = tx.objectStore('unprovenContents').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              eventIndexes: (events.result as Array<{ eventIndex: number }>)
                .map((row) => row.eventIndex)
                .sort((a, b) => a - b),
              tabContent: (tabs.result as Array<{ content: string }>)[0]?.content ?? '',
              unproven: (
                unproven.result as Array<{
                  id: number;
                  reason?: string;
                  content: string;
                  chainContentLength: number;
                  truncatedEvents?: Array<{ sequence: number }>;
                }>
              )
                .sort((a, b) => a.id - b.id)
                .map((row) => ({
                  reason: row.reason,
                  content: row.content,
                  chainContentLength: row.chainContentLength,
                  truncatedSequences: (row.truncatedEvents ?? []).map((e) => e.sequence),
                })),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    CASUAL_SESSION_DB
  );
}

const unprovenDialog = (page: Page) => page.locator('[data-dialog="unproven-content"]');

async function closeUnprovenDialog(page: Page): Promise<void> {
  await unprovenDialog(page).locator('.modal-footer .modal-btn-primary').click();
  await expect(unprovenDialog(page)).toHaveCount(0);
}

function expectVerifyPasses(zipPath: string): void {
  const result = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(allPassed(result.results)).toBe(true);
}

/**
 * export した proof の記録が、飛びの手前 (`kept` 件) までの保存済みの記録をそのまま先頭に持ち、飛びより後の
 * イベントを 1 つも含まないことを確かめる (続きに記録したイベントは、手前の記録の後ろに付く)
 */
async function expectRecordCutBeforeGap(zipPath: string, hashes: StoredHashes, kept: number): Promise<void> {
  const proofHashes = (await readProofEvents(zipPath)).map((event) => event.hash as string);
  expect(proofHashes.slice(0, kept)).toEqual(hashes.slice(0, kept));
  const truncated = new Set(hashes.slice(kept));
  expect(proofHashes.filter((hash) => truncated.has(hash))).toEqual([]);
}

/** 1 行目を打って保存を待ち、その時点の件数と content を返してから 2 行目を打つ */
async function typeTwoParts(app: EditorApp): Promise<{ kept: number; keptContent: string }> {
  await app.typeCode(FIRST);
  await app.waitForSynced();
  const [tab] = (await app.snapshot()).tabs;
  await app.typeCode(SECOND);
  await app.waitForSynced();
  return { kept: tab!.totalEvents, keptContent: tab!.content };
}

test('#878 飛びのある保存データから再開すると、記録は飛びの手前までになり、その後のコードとイベントを保全して知らせ、export も続きの記録も検証を通る', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const { kept, keptContent } = await typeTwoParts(app);
  // 飛びの先に署名済みの checkpoint を作る (export は最後の checkpoint を作って署名を待つ)
  await app.exportAllTabs();
  await app.waitForSynced();
  await page.close();

  const neutral = await context.newPage();
  await neutral.goto(NEUTRAL_PATH);
  const hashes = await removeStoredEvent(neutral, kept);
  const original = (await readStoredRecord(neutral)).tabContent;
  await neutral.close();
  expect(original, 'precondition: the code after the gap is in the saved content').toContain('int b = 2;');

  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  const resume = page2.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();
  await app2.waitReady();

  // バッファは飛びの手前の時点の版 (記録の中身は下の export で確かめる)
  expect((await app2.snapshot()).tabs[0]?.content).toBe(keptContent);

  // #413 と同じ通知に、理由 sequence-gap の行が出る
  const row = unprovenDialog(page2).locator('.unproven-item');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-reason', 'sequence-gap');
  await expect(row).toHaveAttribute('data-original-length', String(original.length));
  await expect(row).toHaveAttribute('data-chain-length', String(keptContent.length));
  await expect(unprovenDialog(page2).locator('.unproven-message')).toHaveAttribute('data-reason', 'sequence-gap');

  // 飛びより後のコードとイベントは保全され、events と位置からは外れる
  const stored = await readStoredRecord(page2);
  expect(stored.unproven).toEqual([
    {
      reason: 'sequence-gap',
      content: original,
      chainContentLength: keptContent.length,
      truncatedSequences: Array.from({ length: hashes.length - kept - 1 }, (_, i) => kept + 1 + i),
    },
  ]);
  // 残った行は 0 から欠けずに続く (再開の後に記録したイベントは、切り詰めた記録の続きに入る)
  expect(stored.eventIndexes).toEqual(stored.eventIndexes.map((_, i) => i));

  await closeUnprovenDialog(page2);

  // 直後の export は、飛びの手前までの記録の続きで、検証を通る
  const restoredZip = await app2.exportAllTabs();
  await expectRecordCutBeforeGap(restoredZip, hashes, kept);
  expectVerifyPasses(restoredZip);

  // そのタブで続きを書いて export しても検証を通る
  await app2.typeCode('int c = 3;\n');
  await app2.waitForSynced();
  const continuedZip = await app2.exportAllTabs();
  await expectRecordCutBeforeGap(continuedZip, hashes, kept);
  expectVerifyPasses(continuedZip);

  // 続きは保存にも残る (古い行と食い違わない): 読み直すと通知は出ず、同じ記録の続きで検証を通る
  const continued = (await readProofEvents(continuedZip)).map((event) => event.hash as string);
  const beforeReload = (await app2.snapshot()).tabs[0]!;
  await app2.reloadAndResume();
  expect((await app2.snapshot()).tabs[0]?.content).toBe(beforeReload.content);
  expect(await app2.openDialogs()).not.toContain('unproven-content');
  const reloadedZip = await app2.exportAllTabs();
  const reloaded = (await readProofEvents(reloadedZip)).map((event) => event.hash as string);
  expect(reloaded.slice(0, continued.length)).toEqual(continued);
  expectVerifyPasses(reloadedZip);
});

test('#878 読み直し (sessionStorage からの復元) でも、飛びの手前で切り詰めて知らせ、export が検証を通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const { kept, keptContent } = await typeTwoParts(app);

  // 開いている間に消しても、保存は書き込み位置より後だけを足すので、消した行は戻らない
  const hashes = await removeStoredEvent(page, kept);
  await page.reload();
  await app.waitReady();

  expect((await app.snapshot()).tabs[0]?.content).toBe(keptContent);
  await expect(unprovenDialog(page).locator('.unproven-item')).toHaveAttribute('data-reason', 'sequence-gap');
  await closeUnprovenDialog(page);

  const zipPath = await app.exportAllTabs();
  await expectRecordCutBeforeGap(zipPath, hashes, kept);
  expectVerifyPasses(zipPath);
});
