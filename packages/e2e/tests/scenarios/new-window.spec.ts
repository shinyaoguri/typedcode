import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { clickMainMenuItem } from '../helpers/scenario.js';

/**
 * #434-12: メインメニューの「新しいウィンドウ」(`#new-window-btn`) は `?fresh=1` で同じモードを別ウィンドウに開く。
 * 元のウィンドウのタブ構成 (id・中身) は変わらず、その後も打鍵が記録されて export が verify (fast) で pass する。
 * 新しいウィンドウの側は起動の途中で止まり、そのまま使えない既知の問題 (#442。仕様判断待ち) があるので、
 * popup の状態は assert しない。
 */
test('新しいウィンドウを開いても元のウィンドウのタブは変わらず、記録が続いて verify (fast) が pass する', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.waitForSynced();
  await app.expectConsistent();
  const tabsBefore = (await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }));

  // popup は起動直後に history.replaceState で `?fresh=1` を消すので、最初のナビゲーションの URL で見る。
  const freshRequest = context.waitForEvent('request', {
    predicate: (r) => r.isNavigationRequest() && r.url().includes('fresh=1'),
    timeout: 30_000,
  });
  const popupPromise = page.waitForEvent('popup');
  await clickMainMenuItem(page, 'new-window-btn');
  const popup = await popupPromise;
  expect(new URL((await freshRequest).url()).pathname).toBe('/casual');
  // popup の起動 (SingleInstanceGuard の ping/pong を含む) が落ち着くまで待ってから元のウィンドウを見る。
  // popup は起動の途中 (ready / duplicate-instance / session-recovery のどれか) で落ち着く。どこで止まるかは
  // #442 で扱うので、どれになったかは assert しない。
  await expect
    .poll(
      () =>
        popup.evaluate(() => {
          if (document.documentElement.dataset.appState === 'ready') return true;
          return [...document.querySelectorAll<HTMLElement>('[data-dialog]')].some(
            (el) =>
              !el.classList.contains('hidden') &&
              (el.dataset.dialog === 'duplicate-instance' || el.dataset.dialog === 'session-recovery')
          );
        }),
      { timeout: 30_000 }
    )
    .toBe(true);

  await page.bringToFront();
  await app.expectConsistent();
  expect((await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }))).toEqual(tabsBefore);
  await popup.close();

  const before = await app.eventCount();
  await app.typeCode(' int b;');
  await app.expectConsistent();
  expect(await app.eventCount()).toBeGreaterThan(before);
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
