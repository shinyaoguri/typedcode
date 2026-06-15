import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, listZipEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 画面共有: casual のバナーから画面共有を有効化すると getDisplayMedia で本物の
 * MediaStream を取得し、screenShareStart と初期キャプチャ (screenshotCapture) が
 * チェーンに記録され、export ZIP に screenshots/ が含まれ、検証が pass する。
 *
 * headless では fake-media フラグ (playwright.config) で getDisplayMedia が monitor の
 * fake ストリームを返すため、ピッカー UI 無しでキャプチャ経路を end-to-end 検証できる。
 */
test('画面共有を有効化すると screenShareStart とスクショがチェーンに記録される', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.enableScreenShare();
  await app.typeCode('int s = 1;\n');
  // 画面共有開始時の初期キャプチャがチェーンと IndexedDB に載るのを待つ。
  await app.waitForSynced();

  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);

  // 画面共有開始とスクショキャプチャが記録されている。
  expect(events.some((e) => e.type === 'screenShareStart'), 'screenShareStart recorded').toBe(true);
  expect(
    events.filter((e) => e.type === 'screenshotCapture').length,
    'screenshotCapture recorded',
  ).toBeGreaterThan(0);

  // export ZIP に screenshots/ が含まれる (実画像が同梱される)。
  const entries = await listZipEntries(zipPath);
  expect(entries.some((n) => /screenshots?\//i.test(n)), 'zip should contain screenshots/').toBe(true);

  // チェーンは valid。
  const result = runVerifyCli(zipPath);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});
