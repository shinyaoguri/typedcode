import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 履歴の移動 (#435): ランディング → casual カード → 打鍵 → 戻る (ランディング) → 進む (casual) と
 * 移動しても、セッションが復元されてチェーンが途切れない (リロード復元と同じ sessionStorage 経路)。
 *
 * 編集中は beforeunload が離脱の確認を求めるので、出たら受け入れる。
 */
test('ランディング → casual → 戻る → 進む、と移動してもセッションが復元され、検証が pass する', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  const app = new EditorApp(page);

  await page.goto('/');
  await expect.poll(() => app.appState()).toBe('landing');
  await page.locator('.landing-card-mode[data-mode="casual"] .lc-open').click();
  await expect(page).toHaveURL(/\/casual$/);
  await app.waitReady();

  await app.typeCode('int a = 1;');
  await app.waitForSynced();
  const beforeCount = await app.eventCount();

  await page.goBack();
  await expect.poll(() => app.appState()).toBe('landing');

  await page.goForward();
  await expect(page).toHaveURL(/\/casual$/);
  // 復元モーダルが出る経路なら再開する (reloadAndResume と同じ扱い)。
  const resume = page.locator('#session-resume-btn');
  try {
    await resume.waitFor({ state: 'visible', timeout: 5_000 });
    await resume.click();
  } catch {
    /* 自動復元 (モーダル無し) */
  }
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');

  // 件数と内容が前の続きになっている (リセットされていない)。
  expect(await app.eventCount()).toBeGreaterThanOrEqual(beforeCount);
  expect((await app.snapshot()).tabs.map((t) => t.content)).toEqual(['int a = 1;']);

  await app.typeCode(' int b = 2;');
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  const proof = (await readProofJson(zipPath)) as { content?: string };
  expect(proof.content).toBe('int a = 1; int b = 2;');
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(true);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
