import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * モードルーティング (#644。ADR-0011 / ADR-0015 のランディングを置き換え): `/` は練習 (casual) のエディタを
 * 直接開き、`/casual` も互換の入口として同じく開く。未知パスは黙って練習にせず、エディタを起動しない
 * 「このページはありません」画面にする (タイポで「試験のつもりが練習」を防ぐ)。判定は `html[data-app-state]` /
 * `html[data-mode]` と、not-found 画面のリンクの `href` だけを読む。
 */

test('/ を開くと練習のエディタが直接開き、打鍵 → export → verify-cli が通る', async ({ page }) => {
  const app = new EditorApp(page);
  await page.goto('/');
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');
  await expect(page).toHaveURL(/\/$/);

  await app.typeCode('int a = 1;');
  await app.waitForSynced();
  await app.expectConsistent();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('/casual を開いても同じ練習のエディタが開き、記録を始める', async ({ page }) => {
  const app = new EditorApp(page);
  await page.goto('/casual');
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');
  await expect(page.locator('#app')).toBeVisible();
  // #0 humanAttestation が記録され、event-count が 1 以上。
  expect(await app.eventCount()).toBeGreaterThan(0);
});

test('未知パス (/exsm) はエディタを起動せず、/ へのリンクだけを持つ画面を出す', async ({ page }) => {
  const app = new EditorApp(page);
  await page.goto('/exsm');
  await expect.poll(() => app.appState()).toBe('not-found');
  // エディタ (#app) は not-found では display:none で不可視化され、Monaco は生成されない。
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  const links = page.locator('#not-found-page a');
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('href', '/');

  // リンクから練習のエディタに入れる。
  await links.click();
  await expect(page).toHaveURL(/\/$/);
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');
});
