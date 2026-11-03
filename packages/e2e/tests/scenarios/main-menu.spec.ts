import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';

/**
 * メインメニュー (`#main-menu-btn`) の項目 (#442)。「新規ウィンドウ」は撤去済み: モードごとに 1 インスタンスの
 * 不変条件 (#237) の下では、同じモードを新しいウィンドウで開いても使えなかったので、ボタンも `?fresh=1` の処理も無い。
 */

test('メインメニューは「新規ファイル」・区切り線・「テンプレートを読み込む」だけで、新規ウィンドウの項目は無い (#442)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await page.locator('#main-menu-btn').click();

  const items = page.locator('#main-menu-dropdown > *');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('id', 'new-file-btn');
  await expect(items.nth(1)).toHaveClass(/dropdown-divider/);
  await expect(items.nth(2)).toHaveAttribute('id', 'import-template-btn');
  await expect(page.locator('#new-window-btn')).toHaveCount(0);
});

test('/casual?fresh=1 を開き直しても、/casual と同じく sessionStorage から復元され、URL の fresh=1 も消えない (#442)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int keep = 1;');
  await app.waitForSynced();
  const tabsBefore = (await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }));

  await page.goto('/casual?fresh=1');
  // 旧実装は ?fresh=1 でタブ状態を消して復旧ダイアログで止まっていた。いまは通常のリロードと同じで、そのまま起動する。
  await expect.poll(() => app.appState(), { timeout: 30_000 }).toBe('ready');
  await app.waitReady();
  expect(await app.openDialogs()).not.toContain('session-recovery');
  expect((await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }))).toEqual(tabsBefore);
  expect(new URL(page.url()).searchParams.get('fresh')).toBe('1');
  await app.expectConsistent();
});
