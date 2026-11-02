import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { clickSettingsItem, waitResumed } from '../helpers/scenario.js';

/**
 * #434-7: 設定メニューのテーマ切替 (`html[data-theme]` が light ↔ dark) と表示言語の切替
 * (`html[lang]` が en ↔ ja。リロードを伴う)。どちらも proof には載らないので、切り替えた後も同じタブの
 * チェーンが続き (同じ id で件数が増える)、export が verify-cli (fast) で pass することで判定する。
 */

test('テーマを切り替えると html[data-theme] が light と dark を往復し、記録は続いて verify が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.expectConsistent();
  const html = page.locator('html');
  const initial = await html.getAttribute('data-theme');
  expect(['light', 'dark']).toContain(initial);
  const other = initial === 'light' ? 'dark' : 'light';

  await clickSettingsItem(page, 'theme-toggle-btn');
  await expect(html).toHaveAttribute('data-theme', other);
  await app.expectConsistent();
  await clickSettingsItem(page, 'theme-toggle-btn');
  await expect(html).toHaveAttribute('data-theme', initial!);

  const before = await app.eventCount();
  await app.typeCode(' int b;');
  await app.expectConsistent();
  expect(await app.eventCount()).toBeGreaterThan(before);
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('表示言語を切り替えるとリロードして html[lang] が en から ja になり、同じタブのチェーンが続いて verify が pass する', async ({
  page,
}) => {
  // 表示言語の切替は skipBeforeUnload を立てずにリロードするので、記録のあるタブでは離脱確認が出る (#445)。
  // ここでは確認を受け入れて切替そのものを確かめる。
  page.on('dialog', (dialog) => void dialog.accept());
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const html = page.locator('html');
  // Playwright の既定ロケールは en-US。
  await expect(html).toHaveAttribute('lang', 'en');
  await app.typeCode('int a;');
  await app.waitForSynced();
  await app.expectConsistent();
  const [tab] = await app.tabs();
  const before = await app.eventCount();

  const reloaded = page.waitForEvent('load');
  await clickSettingsItem(page, 'language-toggle-btn');
  await reloaded;
  await waitResumed(app);
  await expect(html).toHaveAttribute('lang', 'ja');
  await app.expectConsistent();
  expect((await app.tabs()).map((t) => t.id)).toEqual([tab!.id]);

  await app.typeCode(' int b;');
  await app.expectConsistent();
  expect(await app.eventCount()).toBeGreaterThan(before);
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test.fixme('#445 表示言語の切替と ModeSwitcher の遷移で離脱確認 (beforeunload) が出ない', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.waitForSynced();

  const reloaded = page.waitForEvent('load');
  await clickSettingsItem(page, 'language-toggle-btn');
  await reloaded;
  await waitResumed(app);
  await app.waitForSynced();

  await page.locator('#mode-switcher-btn').click();
  await page.locator('.mode-item[data-mode="class"]').click();
  await expect(page).toHaveURL(/\/class$/);
  expect(dialogs).toEqual([]);
});
