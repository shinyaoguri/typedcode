import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { dragTabTo, typeIntoEveryTab } from '../helpers/scenario.js';

/**
 * #434-5: タブをマウスで並べ替える (TabUIController のマウスイベント実装。5px の閾値を超えるとドラッグ)。
 * 並べ替えた順序は DOM と内部状態で一致し、リロードしても保たれる。改名・閉じるのキャンセル・
 * 全部閉じてウェルカムは state-contract.spec.ts が持つのでここでは重ねない。
 */
test('先頭のタブを末尾までドラッグすると順序が変わり、リロード後も保たれ、export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.addTab();
  await app.addTab();
  // 空のタブを含む ZIP は検証が拒否する既知のバグ (#447) を避けるため、全タブに書いておく。
  await typeIntoEveryTab(app, 'int v;');
  await app.expectConsistent();
  const before = (await app.tabs()).map((t) => t.id);
  expect(before).toHaveLength(3);

  const last = await page.locator(`#editor-tabs .editor-tab[data-tab-id="${before[2]}"]`).boundingBox();
  if (!last) throw new Error('last tab is not visible');
  await dragTabTo(page, before[0]!, last.x + last.width - 2);

  const expected = [before[1], before[2], before[0]];
  await expect.poll(async () => (await app.tabs()).map((t) => t.id)).toEqual(expected);
  expect((await app.snapshot()).tabs.map((t) => t.id)).toEqual(expected);
  await app.expectConsistent();

  await app.reloadAndResume();
  await expect.poll(async () => (await app.tabs()).map((t) => t.id)).toEqual(expected);
  await app.expectConsistent();

  await app.typeCode('int after;');
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});
