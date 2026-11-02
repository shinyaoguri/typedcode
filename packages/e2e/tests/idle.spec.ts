import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * アイドル (#435): window の blur から 60 分でアイドル警告 (`idle-warning`) が出て、警告に応答しないまま
 * さらに 5 分で記録が止まる (`idle-suspended`)。復帰ボタンで記録を再開し、export した proof が検証に通る
 * (`IdleTimeoutManager`、main.ts の `initializeIdleTimeoutManager`)。
 *
 * 時間は `page.clock` で進める。install は goto の前 (ページのタイマーを起動時から偽物にする)。
 * install した時計は実時間で流れ続けるので、PoSW やデバウンス保存は普段どおりに進む。
 */
test('blur から 60 分で警告、さらに 5 分で記録停止。復帰して export した proof が pass する', async ({ page }) => {
  await page.clock.install();
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;');
  await app.waitForSynced();

  // headless では本物の blur が出ないので window に投げる (handleBlur は isTrusted を見ない)。
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.fastForward('01:00:00');
  await expect.poll(() => app.openDialogs()).toContain('idle-warning');

  // 警告のカウントダウンは setInterval なので、fastForward (各タイマー高々 1 回) ではなく runFor で回す。
  await page.clock.runFor('05:01');
  await expect.poll(() => app.openDialogs()).toContain('idle-suspended');
  expect(await app.openDialogs()).not.toContain('idle-warning');

  // 復帰: 停止画面の再開ボタン (ロック画面の primary ボタン) を押す。
  await page.locator('[data-dialog="idle-suspended"] .btn-primary').click();
  await expect.poll(() => app.openDialogs()).not.toContain('idle-suspended');

  await app.typeCode(' int b = 2;');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('int a = 1; int b = 2;');

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
