import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { captureDisplayStreams, displayStreamCount, endLastScreenShare } from './helpers/faults.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 画面共有のトラック停止 (#435): 共有中にユーザーがブラウザの「共有を停止」を押す (video トラックに
 * `ended` が届く) と、画面共有の再開を求めるロック画面 (`screen-capture-lock`) が出る
 * (`ScreenCaptureService` の ended 監視 → main.ts の `setStreamStoppedCallback`)。
 *
 * `track.stop()` ではページ自身が止めた扱いになり `ended` が発火しないので、`getDisplayMedia` が返した
 * stream を init script で退避しておき、トラックに `ended` を直接投げる。
 *
 * ロック画面の裏では export の導線が塞がれるので、「画面共有なしで継続」→ 確認で抜けてから export し、
 * 停止が proof に記録されていることと検証が通ることを見る。
 */
test('casual: 画面共有のトラックが止まると screen-capture-lock が出て、screenShareStop が記録される', async ({
  page,
}) => {
  await captureDisplayStreams(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.enableScreenShare();
  // 共有が始まった (getDisplayMedia が stream を返した)。
  await expect.poll(() => displayStreamCount(page)).toBe(1);
  await app.typeCode('int s = 1;');
  await app.waitForSynced();
  expect(await app.openDialogs()).not.toContain('screen-capture-lock');

  expect(await endLastScreenShare(page)).toBeGreaterThan(0);
  await expect.poll(() => app.openDialogs()).toContain('screen-capture-lock');

  // 「画面共有なしで継続」(ロック画面の secondary ボタン) → opt-out の確認で抜ける。
  await page.locator('[data-dialog="screen-capture-lock"] .btn-secondary').click();
  await expect.poll(() => app.openDialogs()).toContain('screen-share-optout-confirm');
  await page.locator('.screen-share-optout-confirm-dialog [data-action="confirm"]').click();
  await expect.poll(() => app.openDialogs()).toEqual([]);

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const types = (await readProofEvents(zipPath)).map((e) => e.type);
  // 開始 → 停止の順に記録されている。
  expect(types).toContain('screenShareStart');
  expect(types.indexOf('screenShareStop')).toBeGreaterThan(types.indexOf('screenShareStart'));

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
