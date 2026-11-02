import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * ネットワークの切断と復帰 (#435): 読込後に `context.setOffline(true)` → `setOffline(false)` とすると、
 * NetworkTracker が `networkStatusChange` で offline / online の遷移を記録し、proof は検証に通る。
 *
 * setOffline は**読込後にだけ**使う (読込前に入れると Monaco などの読み込みまで遮断される)。
 * Vite の HMR の WebSocket が切れて再接続時にページを読み直すと記録が途切れるので、
 * オフラインの間にページが読み直されていないことも見る (navigation の回数)。
 */
test('読込後のオフライン → オンラインが proof に記録され、検証が pass する', async ({ page, context }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int n = 1;\n');
  await app.waitForSynced();

  // 以降に main frame のナビゲーション (= ページの読み直し) が起きたら数える。
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await context.setOffline(true);
  await page.waitForTimeout(1_500);
  await context.setOffline(false);
  // online の記録とオンライン復帰後の処理 (再送など) が落ち着くのを待つ。
  await page.waitForTimeout(1_500);
  expect(navigations, 'page must not reload across the offline window').toBe(0);

  await app.typeCode('int m = 2;\n');
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  // 起動時の 1 件 (true) → オフライン (false) → 復帰 (true) の順に並ぶ。
  const events = await readProofEvents(zipPath);
  const online = events
    .filter((e) => e.type === 'networkStatusChange')
    .map((e) => (e.data as { online?: boolean } | undefined)?.online);
  expect(online).toEqual([true, false, true]);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
