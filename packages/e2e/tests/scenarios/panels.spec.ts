import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { dragBy, loadClassPackage, panelOpen, waitDialogOpen, widthOf } from '../helpers/scenario.js';

/**
 * #434-10: ログビューア (`#log-viewer`) と問題パネル (`#problem-panel`) の開閉とリサイズ。開閉は状態契約
 * `data-open` で、リサイズはパネルの幅 (boundingBox) の変化で見る。操作のたびに DOM と内部状態が一致し、
 * 最後の export が verify-cli (fast) で pass する。ログのクリアは UI にボタンが無い (#443) ので対象外。
 */
test('class: 問題パネルとログビューアを開閉・リサイズしても状態が一致し、export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);
  await app.typeCode('int a;');

  // 問題パネル: 読み込みで開く → × で閉じる → Activity Bar のトグルで開く → 右端のハンドルで広げる。
  expect(await panelOpen(page, 'problem-panel')).toBe('true');
  await page.locator('#close-problem-btn').click();
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'false');
  await app.expectConsistent();
  await page.locator('#toggle-problem-btn').click();
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'true');
  const problemBefore = await widthOf(page, '#problem-panel');
  await dragBy(page, '#problem-resize-handle', 120);
  await expect.poll(() => widthOf(page, '#problem-panel')).toBeGreaterThan(problemBefore + 50);
  await app.expectConsistent();

  // ログビューア: トグルで開く → 左端のハンドルで広げる → × で閉じる → もう一度開く。
  expect(await panelOpen(page, 'log-viewer')).toBe('false');
  await page.locator('#toggle-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'true');
  const logBefore = await widthOf(page, '#log-viewer');
  await dragBy(page, '#log-resize-handle', -120);
  await expect.poll(() => widthOf(page, '#log-viewer')).toBeGreaterThan(logBefore + 50);
  await app.expectConsistent();
  await page.locator('#close-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'false');
  await page.locator('#toggle-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'true');
  await app.expectConsistent();

  await app.typeCode(' int b;');
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});
