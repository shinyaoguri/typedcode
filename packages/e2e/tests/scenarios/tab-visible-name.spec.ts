import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { loadExamFixture } from '../helpers/examFixture.js';
import { loadClassPackage, waitDialogOpen } from '../helpers/scenario.js';

/**
 * タブに見える名前 (#828)。タブは名前を `.tab-filename` と `.tab-extension` の 2 つの span に分けて描く。
 * class / exam の問題から作ったタブは保存されている名前が拡張子込み (`p1.c`) なので、拡張子をそのまま
 * 足すと `p1.c.c` と見えていた (`data-filename` は #441 で `p1.c` に直っていたが、見える文字は直っていなかった)。
 * 改名で拡張子込みの名前 (`q.c`) を入れたときも同じ。
 *
 * ここでは 2 つの span をつなげた文字 (`visibleTabNames()`) を、`data-filename` との一致とリテラルの
 * 両方で見る (ファイル名は翻訳されないので文字のまま比べてよい)。一致そのものは `expectConsistent()` の
 * 不変条件にも入れてあり、各テストはそれで締める。
 *
 * 証明 (ハッシュチェーン) に関わらない表示の検査なので、verify-cli は呼ばない。
 */

test('class: .tcclass の問題から作ったタブは、starter の filename と <problemId>.<ext> がそのまま見える', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);

  expect(await app.visibleTabNames()).toEqual(['p1.c', 'p2.c']);
  expect(await app.visibleTabNames()).toEqual((await app.tabs()).map((t) => t.filename));
  await app.expectConsistent();
});

test('exam: 解錠したタブは starter の filename (main.c) がそのまま見える', async ({ page }) => {
  const fixture = loadExamFixture();
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await expect.poll(() => app.appState()).toBe('gate');
  await app.unlockExam(fixture.packagePath, fixture.code);

  expect(await app.visibleTabNames()).toEqual(['main.c']);
  expect(await app.visibleTabNames()).toEqual((await app.tabs()).map((t) => t.filename));
  await app.expectConsistent();
});

test('casual: 起動直後の既定タブは Untitled-1.c と見える', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  expect(await app.visibleTabNames()).toEqual(['Untitled-1.c']);
  expect((await app.tabs()).map((t) => t.filename)).toEqual(['Untitled-1.c']);
  await app.expectConsistent();
});

test('casual: 拡張子込みの名前に改名しても拡張子は 1 つだけ見え、拡張子の無い名前には言語の拡張子が付く', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const [tab] = await app.tabs();
  if (!tab) throw new Error('no default tab');

  const expectVisible = async (name: string) => {
    expect(await app.visibleTabNames()).toEqual([name]);
    expect((await app.tabs()).map((t) => t.filename)).toEqual([name]);
    await app.expectConsistent();
  };

  await app.renameTab(tab.id, 'main.c');
  await expectVisible('main.c');

  await app.renameTab(tab.id, 'next.c');
  await expectVisible('next.c');

  await app.renameTab(tab.id, 'plain');
  await expectVisible('plain.c');
});

test('casual: 改名の編集中は、拡張子込みの名前のタブでだけ拡張子の span を隠し、Escape で元の見え方に戻る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const [tab] = await app.tabs();
  if (!tab) throw new Error('no default tab');
  const tabEl = page.locator(`#editor-tabs .editor-tab[data-tab-id="${tab.id}"]`);
  const input = tabEl.locator('.tab-filename-input');
  const extension = tabEl.locator('.tab-extension');

  await test.step('拡張子の無い名前 (Untitled-1) の編集中は、入力欄の右に拡張子が見えている', async () => {
    await tabEl.locator('.tab-filename').dblclick();
    await input.waitFor({ state: 'visible' });
    await expect(input).toHaveValue('Untitled-1');
    await expect(extension).toBeVisible();
    await input.press('Escape');
    await input.waitFor({ state: 'detached' });
    expect(await app.visibleTabNames()).toEqual(['Untitled-1.c']);
    await app.expectConsistent();
  });

  await test.step('拡張子込みの名前 (main.c) の編集中は、拡張子の span が隠れ、Escape で main.c に戻る', async () => {
    await app.renameTab(tab.id, 'main.c');
    await tabEl.locator('.tab-filename').dblclick();
    await input.waitFor({ state: 'visible' });
    await expect(input).toHaveValue('main.c');
    await expect(extension).toBeHidden();
    await input.press('Escape');
    await input.waitFor({ state: 'detached' });
    expect(await app.visibleTabNames()).toEqual(['main.c']);
    await expect(extension).toBeVisible();
    await app.expectConsistent();
  });
});
