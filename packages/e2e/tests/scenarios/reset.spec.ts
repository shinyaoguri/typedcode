import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  clickSettingsItem,
  loadClassPackage,
  typeIntoEveryTab,
  waitDialogClosed,
  waitDialogOpen,
} from '../helpers/scenario.js';

/**
 * #434-8: 設定メニューのリセット (`data-dialog="reset"`)。Esc と背景のクリックでは何も消さずに閉じ
 * (タブの id と中身が変わらない。件数はマウスのイベントで増えうるので見ない)、確定すると `?reset=<ts>` で
 * 全消去して起動し直す。class / assignment は確定後にタブ 0 本のウェルカム、casual は ADR-0015 どおり
 * 新しい既定タブが 1 本できる (前のタブ id は残らない)。
 */

/** タブの id と中身 (件数を除く)。 */
async function tabState(app: EditorApp) {
  return (await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }));
}

async function openReset(app: EditorApp): Promise<void> {
  await clickSettingsItem(app.page, 'reset-btn');
  await waitDialogOpen(app, 'reset');
}

test('class: リセットは Esc と背景クリックでは何も消さずに閉じ、確定すると全タブが消えてウェルカムになる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);
  // 全タブに書いておき、閉じただけのリセットで全タブの中身が保たれることを見る。
  await typeIntoEveryTab(app, 'int keep;');
  await app.waitForSynced();
  await app.expectConsistent();
  const before = await tabState(app);

  await openReset(app);
  await page.keyboard.press('Escape');
  await waitDialogClosed(app, 'reset');
  expect(await tabState(app)).toEqual(before);

  await openReset(app);
  // ダイアログの外側 (オーバーレイ自身) を押す。
  await page.locator('#reset-dialog').click({ position: { x: 5, y: 5 } });
  await waitDialogClosed(app, 'reset');
  expect(await tabState(app)).toEqual(before);
  await app.expectConsistent();

  // 閉じたあとも記録は壊れていない。
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  await openReset(app);
  await page.locator('#reset-confirm-btn').click();
  await expect(page).toHaveURL(/\/class(\?|$)/);
  // 全消去のあと起動し直す。規約の同意は init script が戻すので、出るのは画面共有の選択から。
  await waitDialogOpen(app, 'screen-share-choice');
  await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();
  await waitDialogOpen(app, 'welcome');
  await expect.poll(() => app.appState()).toBe('ready');
  expect(await app.tabs()).toEqual([]);
  await app.expectConsistent();
});

test('casual: リセットを確定すると前のタブは残らず、新しい既定タブで記録が始まって verify が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old;');
  await app.waitForSynced();
  const oldIds = (await app.tabs()).map((t) => t.id);

  await openReset(app);
  await page.locator('#reset-confirm-btn').click();
  await expect(page).toHaveURL(/\/casual(\?|$)/);
  await app.waitReady();
  await app.expectConsistent();
  const tabs = await app.snapshot();
  expect(tabs.tabs).toHaveLength(1);
  expect(oldIds).not.toContain(tabs.tabs[0]!.id);
  expect(tabs.tabs[0]!.content).toBe('');

  await app.typeCode('int fresh;');
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  expect(JSON.stringify(await readProofEvents(zipPath))).not.toContain('old;');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
