import { test, expect, type Page } from '@playwright/test';
import { BOOT_TIMEOUT_MS, CASUAL_SESSION_DB, EditorApp } from './helpers/app.js';
import { allPassed, runVerifyCliWithResult } from './helpers/verifyCli.js';

/**
 * PoSW の処理待ちが続く間も、保存済みの events に sequence の飛びが出ない (#873)。
 *
 * 連続打鍵で処理待ちが積もっている間は、TabManager のデバウンス保存 (saveToIndexedDB) が発火しない
 * (確定のたびに saveToStorage がタイマーを張り直す)。以前は contentSnapshot (100 イベントごと) を
 * proof へ直接記録し、IndexedDB への append をそのデバウンス保存に任せていたので、処理待ちが掃ける前に
 * 読み直すと、保存済みの events にスナップショットの分だけ飛びが残り、export が verify-cli で
 * `Sequence mismatch` になった。
 *
 * 手順は #628 のベンチ (`real typing`) の打ち方に合わせる: 200 文字ずつ打ち、処理待ちが 1,000 件以下に
 * なるまで待って次を打つ。3 回目の時点で 1 回目と 2 回目の処理中に予約されたスナップショットが確定している。
 * 処理待ちが残っている (= デバウンス保存がまだ走っていない) うちに IndexedDB を直接読み、続けて
 * 掃けるのを待たずにリロードする。
 *
 * 実時間で 1〜2 分かかる (PoSW を実際に回す) ので `@nightly`。
 */

const CHUNK = 'v1 = v1 + 1;\n'.repeat(16).slice(0, 200);
const ROUNDS = 3;
const MAX_PENDING = 1000;

async function pendingCount(app: EditorApp): Promise<number> {
  const snap = await app.snapshot();
  return snap.tabs.find((x) => x.id === snap.activeTabId)?.pendingCount ?? 0;
}

/** casual の session DB の events を、保存済みの (sequence, type) の昇順で読む */
function readStoredEvents(page: Page): Promise<Array<{ sequence: number; type: string }>> {
  return page.evaluate(
    (dbName) =>
      new Promise<Array<{ sequence: number; type: string }>>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(['events'], 'readonly').objectStore('events').getAll();
          req.onsuccess = () => {
            db.close();
            const rows = req.result as Array<{ eventIndex: number; eventData: { type: string } }>;
            resolve(
              rows
                .map((r) => ({ sequence: r.eventIndex, type: r.eventData.type }))
                .sort((a, b) => a.sequence - b.sequence)
            );
          };
          req.onerror = () => reject(req.error);
        };
      }),
    CASUAL_SESSION_DB
  );
}

test('連続打鍵の処理待ちが残ったまま読み直しても、保存済みの events に飛びが無く export が検証に通る @nightly', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const gapLogs: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Event sequence gap')) gapLogs.push(m.text());
  });

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.focusEditor();

  for (let i = 0; i < ROUNDS; i++) {
    await page.keyboard.type(CHUNK);
    await expect.poll(() => pendingCount(app), { timeout: 300_000, intervals: [200] }).toBeLessThanOrEqual(MAX_PENDING);
  }

  // 処理待ちが残っている (デバウンス保存がまだ走っていない) うちに読む
  const stored = await readStoredEvents(page);
  expect(await pendingCount(app)).toBeGreaterThan(0);

  // 保存済みの events は 0 から欠けずに続く
  expect(stored.map((e) => e.sequence)).toEqual(stored.map((_, i) => i));
  // 前提: 処理中に予約されたスナップショットが確定して、保存済みの範囲に入っている (飛びが無いのが自明な状況でない)
  expect(stored.filter((e) => e.type === 'contentSnapshot').length).toBeGreaterThan(0);

  // 掃けるのを待たずに読み直す (reloadAndResume は同期を待つので使わない)
  await page.reload();
  const resume = page.locator('#session-resume-btn');
  try {
    await resume.waitFor({ state: 'visible', timeout: 5_000 });
    await resume.click();
  } catch {
    /* 自動復元 (モーダル無し) */
  }
  await page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await expect.poll(() => app.eventCount(), { timeout: 30_000 }).toBeGreaterThan(stored.length - 1);
  expect(gapLogs).toEqual([]);

  // 処理待ちだった打鍵はチェーンに載っていないので、元のコードとの差分の通知が出る (#413)。閉じて続ける
  const unproven = page.locator('[data-dialog="unproven-content"]');
  await unproven.locator('.modal-footer .modal-btn-primary').click();
  await expect(unproven).toHaveCount(0);

  await app.typeCode('x');
  const zipPath = await app.exportAllTabs();
  const result = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(allPassed(result.results)).toBe(true);
});
