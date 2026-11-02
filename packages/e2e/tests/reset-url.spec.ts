import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted } from './helpers/app.js';

/**
 * #323: URL に `?reset=<値>` を付けて開くだけで、確認なしに全モードの localStorage・sessionStorage・
 * セッション DB が消える (main.ts 先頭の `?reset` ハンドラ)。期待 (#323 の受け入れ条件 1):
 * `/<mode>?reset=1` で開いても、localStorage・sessionStorage・どのモードの session DB も消えない。
 *
 * 値を付ける (`?reset=1`): 値の無い `?reset` は `urlParams.get('reset')` が空文字で偽になり、
 * 今も何も消さないので空振りする (#323。ヘルパの doc の誤りは #323 の受け入れ条件 6 が扱う)。
 */
test.fixme('#323 /casual?reset=1 で開いても、どのモードの session DB も localStorage / sessionStorage も消えない', async ({
  page,
}) => {
  const app = new EditorApp(page);
  // 準備: casual に記録を残し、同じタブで assignment も一度開いてその DB を作る。
  await app.openCasualFresh();
  await app.typeCode('int keep = 1;');
  await app.waitForSynced();
  await installTermsAccepted(page);
  await page.goto('/assignment');
  await expect.poll(() => app.openDialogs(), { timeout: 30_000 }).toContain('welcome');
  await page.evaluate(() => {
    localStorage.setItem('tc-e2e-marker', 'local');
    sessionStorage.setItem('tc-e2e-marker', 'session');
  });
  const dbsBefore = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbsBefore).toEqual(expect.arrayContaining(['typedcode-session', 'typedcode-session-assignment']));

  await page.goto('/casual?reset=1');
  await expect.poll(() => app.appState(), { timeout: 30_000 }).toBe('ready');

  const after = await page.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name),
    local: localStorage.getItem('tc-e2e-marker'),
    session: sessionStorage.getItem('tc-e2e-marker'),
  }));
  expect(after.dbs).toEqual(expect.arrayContaining(['typedcode-session', 'typedcode-session-assignment']));
  expect(after.local).toBe('local');
  expect(after.session).toBe('session');
});
