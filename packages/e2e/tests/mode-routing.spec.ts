import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * モードルーティング (ADR-0011 / ADR-0015): `/` と未知パスはモード選択ランディング、
 * `/casual` は明示ルートでエディタ起動、`?reset` でクリーン起動。タイポを黙って casual に
 * しない (事故防止) ことを実ブラウザで担保する。
 */

test('ルート / はランディング (エディタ非初期化・4モードカード)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#landing-page')).toBeVisible();
  // エディタ (#app) は landing では display:none で不可視化される。
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.landing-card-mode[data-mode]')).toHaveCount(4);
  for (const mode of ['casual', 'class', 'assignment', 'exam']) {
    await expect(page.locator(`.landing-card-mode[data-mode="${mode}"]`)).toBeVisible();
  }
});

test('未知パスはランディングに落ちる (タイポを黙って casual にしない)', async ({ page }) => {
  await page.goto('/exsm');
  await expect(page.locator('#landing-page')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.landing-card-mode[data-mode]')).toHaveCount(4);
});

test('/casual は明示ルートでエディタを起動し記録を開始する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines').first()).toBeVisible();
  await expect(page.locator('#landing-page')).toHaveCount(0);
  // #0 humanAttestation が記録され、event-count が 1 以上。
  expect(await app.eventCount()).toBeGreaterThan(0);
});

test('ランディングの casual カードから /casual へ遷移する', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#landing-page')).toBeVisible();
  await page.locator('.landing-card-mode[data-mode="casual"] .lc-open').click();
  await expect(page).toHaveURL(/\/casual$/);
  await expect(page.locator('.monaco-editor .view-lines').first()).toBeVisible();
});
