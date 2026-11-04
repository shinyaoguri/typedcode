import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import {
  failSessionDbOpen,
  idbOpenFailureCount,
  injectQuotaExceeded,
  quotaFailureCount,
  restoreStorageFaults,
} from './helpers/faults.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 保存先 (IndexedDB / sessionStorage) の障害 (#435)。
 * - #325: 起動時の open の失敗でスピナーのまま止まらず、再読み込みを案内するエラー画面 (`boot-failure`) が出る
 * - #543 (#300 段階 1a): 保存 (add / put / setItem) の QuotaExceeded で同期状態が `failed` / `degraded` になり、
 *   そのままでも export が出て verify-cli で PASS する。注入を解除すると `synced` に戻り、リロードして
 *   IndexedDB から復元した後の export も PASS する。transaction の abort は `fault-storage-abort.spec.ts`
 */

/** 起動を止めるエラー画面が出るまでの上限。「数秒以内」に出ることを期待する。 */
const BOOT_ERROR_TIMEOUT_MS = 5_000;

/**
 * #325: 起動時に `indexedDB.open` が失敗しても、`initializeApp` の reject を拾って、数秒以内に
 * 起動を止めるエラー画面 (`[data-dialog="boot-failure"]`) を出す。修正前は誰も拾わず、
 * `html[data-app-state]` が `initializing` のまま無限スピナーになっていた。
 * 画面には再読み込みの操作だけを置き、保存データを消す操作 (リセットなど) は置かない。
 */
test('#325 IndexedDB の open が失敗すると、起動を止めるエラー画面が数秒以内に出る', async ({ page }) => {
  await failSessionDbOpen(page);
  const app = new EditorApp(page);
  await page.goto('/casual');

  // 注入が効いた (セッション DB の open を失敗させた)。
  await expect.poll(() => idbOpenFailureCount(page)).toBeGreaterThan(0);
  await expect.poll(() => app.openDialogs(), { timeout: BOOT_ERROR_TIMEOUT_MS }).toEqual(['boot-failure']);

  const dialog = page.locator('[data-dialog="boot-failure"]');
  await expect(page.locator('#boot-failure-reload-btn')).toBeVisible();
  // 操作は再読み込みの 1 つだけ (データを消す操作を置かない)。
  await expect(dialog.locator('button')).toHaveCount(1);
  // 編集できる状態には進まない (エラー画面で止まる)。
  expect(await app.appState()).toBe('initializing');
});

/**
 * #300 の受け入れ条件 1 (#543): IDB と sessionStorage がどちらも失敗したら `failed`、IDB だけなら `degraded`。
 * 修正前は、`executeSave` が sessionStorage への退避で正常完了扱いにし、同期状態は pending の有無だけで
 * `synced` に戻っていた。
 */
for (const [scope, expected] of [
  ['idbAndSessionStorage', 'failed'],
  ['idb', 'degraded'],
] as const) {
  test(`#300 保存時に QuotaExceeded (${scope}) が起きると、同期状態が ${expected} になる`, async ({ page }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode('int q = 1;\n');
    await app.waitForSynced();

    await injectQuotaExceeded(page, scope);
    await app.typeCode('int r = 2;\n');

    // 注入が効いた (保存が書き込みに来て投げられた)。
    await expect.poll(() => quotaFailureCount(page)).toBeGreaterThan(0);
    await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', expected, { timeout: 15_000 });
  });
}

/** verify-cli (fast) で ZIP 内の全 proof が PASS し、proof が `tabs` 本あることを確かめる。 */
async function expectZipPasses(zipPath: string, tabs: number): Promise<void> {
  expect(await listProofEntries(zipPath)).toHaveLength(tabs);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
}

/**
 * #300 の受け入れ条件 5 (#543): IndexedDB に届かなくても、通常の export (proof) が出て verify-cli で PASS する。
 * 修正前は、export 前の `flushToIndexedDB()` の例外で export 全体が失敗し、ZIP がダウンロードされなかった。
 */
test('#300 IndexedDB の保存が QuotaExceeded で失敗していても、全タブ export の ZIP が verify-cli で PASS する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int q = 1;\n');
  await app.addTab();
  await app.typeCode('int s = 3;\n');
  await app.waitForSynced();

  await injectQuotaExceeded(page, 'idb');
  await app.typeCode('int r = 2;\n');
  await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', 'degraded', { timeout: 15_000 });

  const zipPath = await app.exportAllTabs();
  // export の前の保存 (flush) も書き込みに来て投げられた = 失敗したまま export が進んだ
  expect(await quotaFailureCount(page)).toBeGreaterThan(0);
  await expectZipPasses(zipPath, 2);
});

/**
 * #300 の受け入れ条件 3 (#543): 注入を解除して打鍵を続けると `synced` に戻り、その後の export が verify-cli で
 * PASS する。リロードして IndexedDB から復元した状態で export しても PASS する (失敗中に書けなかった
 * イベントを、再試行が欠番も重複も無く IndexedDB に書き戻している)。
 */
test('#300 保存の失敗から回復すると synced に戻り、リロード後も含めて export が verify-cli で PASS する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int q = 1;\n');
  await app.waitForSynced();

  await injectQuotaExceeded(page, 'idbAndSessionStorage');
  await app.typeCode('int r = 2;\n');
  await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });

  await restoreStorageFaults(page);
  // 回数は解除の後に控える。`failed` は最初の失敗で出るので、そこから解除までの間も、PoSW が後から確定した
  // イベントの保存と再試行が注入に当たって回数が増えうる (#567)。解除後は注入の関数が外れているので増えない
  const failures = await quotaFailureCount(page);
  expect(failures).toBeGreaterThan(0);
  await app.typeCode('int t = 4;\n');
  await app.waitForSynced();
  // 解除後は注入に届いていない (回復は本物の保存で起きた)
  expect(await quotaFailureCount(page)).toBe(failures);
  await expectZipPasses(await app.exportAllTabs(), 1);

  await app.reloadAndResume();
  await app.waitForSynced();
  await expectZipPasses(await app.exportAllTabs(), 1);
});
