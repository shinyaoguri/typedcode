import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { failSessionDbOpen, idbOpenFailureCount, injectQuotaExceeded, quotaFailureCount } from './helpers/faults.js';

/**
 * 保存先 (IndexedDB) の障害 (#435)。どちらも既知のバグの再現で、修正 PR で `fixme` を外す
 * (e2e AGENTS.md の不変条件 5)。
 */

/** 起動を止めるエラー画面が出るまでの上限。「数秒以内」に出ることを期待する。 */
const BOOT_ERROR_TIMEOUT_MS = 5_000;

/**
 * #325: 起動時に `indexedDB.open` が失敗すると、`initializeApp` の reject を誰も拾わず
 * `html[data-app-state]` が `initializing` のまま無限スピナーになる。
 * 期待: 数秒以内に、起動を止めるエラー画面が `[data-dialog]` で出る (名前は #325 の修正 PR で決まるので
 * ここでは名前を問わず「何か開いている」ことを見る)。
 */
test.fixme('#325 IndexedDB の open が失敗すると、起動を止めるエラー画面が数秒以内に出る', async ({ page }) => {
  await failSessionDbOpen(page);
  const app = new EditorApp(page);
  await page.goto('/casual');

  // 注入が効いた (セッション DB の open を失敗させた)。
  await expect.poll(() => idbOpenFailureCount(page)).toBeGreaterThan(0);
  await expect.poll(() => app.openDialogs(), { timeout: BOOT_ERROR_TIMEOUT_MS }).not.toEqual([]);
  // 編集できる状態には進まない (エラー画面で止まる)。
  expect(await app.appState()).toBe('initializing');
});

/**
 * #300: 保存 (IDB の add / put) が QuotaExceeded で失敗しても、`executeSave` は sessionStorage への退避で
 * 正常完了扱いにし、同期状態は pending の有無だけで `synced` に戻る。
 * 期待 (#300 の受け入れ条件 1): IDB と sessionStorage がどちらも失敗したら `failed`、IDB だけなら `degraded`。
 */
for (const [scope, expected] of [
  ['idbAndSessionStorage', 'failed'],
  ['idb', 'degraded'],
] as const) {
  test.fixme(`#300 保存時に QuotaExceeded (${scope}) が起きると、同期状態が ${expected} になる`, async ({ page }) => {
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
