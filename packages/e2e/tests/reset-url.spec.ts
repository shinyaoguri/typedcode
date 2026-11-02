import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted } from './helpers/app.js';

/**
 * #323: URL に `?reset=<値>` を付けて開いても何も消えない (URL 起動の全消去は撤去済み。消去は設定メニューの
 * リセットを確定したときの現在のモードだけ)。リンクを踏ませるだけで全モードのデータを消せてはいけない。
 * `?reset=1` のように値を付けて確かめる (値の無い `?reset` も同じく何も消さないが、旧実装は値の有無で
 * 挙動が分かれていたので、消す側に倒れていた形で検査する)。
 */
test('#323 /casual?reset=1 で開いても、どのモードの session DB も localStorage / sessionStorage も消えない', async ({
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
