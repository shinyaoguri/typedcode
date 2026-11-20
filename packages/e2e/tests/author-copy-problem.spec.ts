import { test, expect, type Page } from '@playwright/test';
import {
  appendToEditor,
  authorRoot,
  createOpfsFolder,
  dialog,
  explorerItem,
  listFolderFiles,
  openAuthorFolder,
  openExistingFolder,
  openFromExplorer,
  readFolderFile,
  setNextPickedFolder,
  waitForAuthorHook,
  waitForOpenFolder,
} from './helpers/author.js';

/**
 * `/author` の「別のフォルダへコピー」(#800 / ADR-0051 Decision 8)。
 *
 * コピー元とコピー先は OPFS の 2 つのフォルダ。ネイティブのフォルダのピッカーは Playwright で操作できないので、
 * dev フックの `setNextPickedDirectory` で、画面が次に開くピッカーの結果をコピー先のハンドルに差し替える。
 * 結果は `copy-result` のダイアログの `data-copy-status` とパスの一覧 (`[data-copy-paths] > li[data-path]`) で読む。
 * コピーの規則そのもの (衝突・欠損・書く順) はユニットテスト (copyProblem.test.ts) が担う。
 */

const SOURCE = 'e2e-copy-source-800';
const DEST = 'e2e-copy-dest-800';
const PROBLEM = '過去問/探索.problem.yaml';

/** 本文をサブフォルダの外 (`共通.md`) と共有する問題を含む教材 */
const MATERIAL: Record<string, string> = {
  '過去問/探索.problem.yaml':
    '# 探索の問題\nformat: tc-problem/1\nid: 探索\ntitle: 探索\nstatement: ../共通.md\nstarter: 探索.c\nsolutions: [探索-解答.c]\n',
  '過去問/探索.c': 'int main(void) {\n  return 0;\n}\n',
  '過去問/探索-解答.c': 'int main(void) { return 1; }\n',
  '共通.md': '# 探索\n\n値を探す。\n',
  'p2.problem.yaml': 'format: tc-problem/1\nid: p2\ntitle: 合計\nstatement: 共通.md\n',
};
const COPIED = ['共通.md', '過去問/探索-解答.c', '過去問/探索.c', '過去問/探索.problem.yaml'];

function copyButton(page: Page, problemPath: string) {
  return page.locator(`#author-explorer [data-action="copy-problem"][data-problem-path="${problemPath}"]`);
}

async function copyTo(page: Page, problemPath: string, destination: string): Promise<void> {
  await setNextPickedFolder(page, destination);
  await copyButton(page, problemPath).click();
}

function copiedPaths(page: Page, kind: string): Promise<string[]> {
  return dialog(page, 'copy-result')
    .locator(`[data-copy-paths="${kind}"] > li[data-path]`)
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.path ?? ''));
}

test('/author: 問題をコピーすると、コピー先に定義と参照ファイルが同じ相対パス・同じ内容ででき、コピー先を開くとその問題が並ぶ', async ({
  page,
}) => {
  await openAuthorFolder(page, SOURCE, MATERIAL);
  await createOpfsFolder(page, DEST, {});

  await copyTo(page, PROBLEM, DEST);
  await expect(dialog(page, 'copy-result')).toHaveAttribute('data-copy-status', 'copied');
  expect((await copiedPaths(page, 'written')).sort()).toEqual(COPIED);
  expect(await listFolderFiles(page, DEST)).toEqual(COPIED);
  for (const path of COPIED) expect(await readFolderFile(page, DEST, path)).toBe(MATERIAL[path]);
  await dialog(page, 'copy-result').locator('[data-action="close"]').click();
  await expect(dialog(page, 'copy-result')).toHaveCount(0);
  // 開いている教材フォルダはそのまま
  await expect(authorRoot(page)).toHaveAttribute('data-folder-name', SOURCE);

  await openExistingFolder(page, DEST);
  await expect(explorerItem(page, PROBLEM, 'problem')).toBeVisible();
  const parts = page.locator('#author-explorer .author-explorer-parts [data-explorer-path]');
  expect(
    await parts.evaluateAll((items) =>
      items.map((item) => [
        (item as HTMLElement).dataset.role,
        (item as HTMLElement).dataset.explorerPath,
        (item as HTMLElement).dataset.missing ?? 'false',
      ])
    )
  ).toEqual([
    ['statement', '共通.md', 'false'],
    ['starter', '過去問/探索.c', 'false'],
    ['solution', '過去問/探索-解答.c', 'false'],
  ]);
});

test('/author: コピー先に同じ名前のファイルが 1 つあると、何も書かずに衝突したパスを示す', async ({ page }) => {
  await openAuthorFolder(page, SOURCE, MATERIAL);
  await createOpfsFolder(page, DEST, { '共通.md': '# コピー先の本文\n' });

  await copyTo(page, PROBLEM, DEST);
  await expect(dialog(page, 'copy-result')).toHaveAttribute('data-copy-status', 'conflict');
  expect(await copiedPaths(page, 'conflict')).toEqual(['共通.md']);
  expect(await listFolderFiles(page, DEST)).toEqual(['共通.md']);
  expect(await readFolderFile(page, DEST, '共通.md')).toBe('# コピー先の本文\n');
});

test('/author: 今開いているフォルダをコピー先に選ぶと、同じフォルダだと知らせて何も書かない', async ({ page }) => {
  await openAuthorFolder(page, SOURCE, MATERIAL);

  await copyTo(page, PROBLEM, SOURCE);
  await expect(dialog(page, 'copy-result')).toHaveAttribute('data-copy-status', 'same-folder');
  expect(await listFolderFiles(page, SOURCE)).toEqual(Object.keys(MATERIAL).sort());
});

test('/author: 問題のファイルに未保存の編集があると、ピッカーを開かずに先に保存するよう知らせる', async ({ page }) => {
  await openAuthorFolder(page, SOURCE, MATERIAL);
  await createOpfsFolder(page, DEST, {});
  // 本物のピッカーの代わりに、呼ばれた回数を数える (呼ばれたらコピー先を返す)
  await page.evaluate(async (folder) => {
    const counter = window as unknown as { __pickerCalls: number; showDirectoryPicker: unknown };
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    counter.__pickerCalls = 0;
    counter.showDirectoryPicker = async () => {
      counter.__pickerCalls++;
      return handle;
    };
  }, DEST);

  await openFromExplorer(page, '過去問/探索.c', 'starter');
  await appendToEditor(page, '/* 未保存の追記 */');
  await copyButton(page, PROBLEM).click();

  await expect(dialog(page, 'copy-result')).toHaveAttribute('data-copy-status', 'dirty');
  expect(await copiedPaths(page, 'dirty')).toEqual(['過去問/探索.c']);
  expect(await page.evaluate(() => (window as unknown as { __pickerCalls: number }).__pickerCalls)).toBe(0);
  expect(await listFolderFiles(page, DEST)).toEqual([]);
});

test('/author: 問題をコピーした後にページを読み直すと、コピー先ではなく元の教材フォルダで再開する', async ({
  page,
}) => {
  await openAuthorFolder(page, SOURCE, MATERIAL);
  await createOpfsFolder(page, DEST, {});

  await copyTo(page, PROBLEM, DEST);
  await expect(dialog(page, 'copy-result')).toHaveAttribute('data-copy-status', 'copied');

  await page.reload();
  await waitForAuthorHook(page);
  await waitForOpenFolder(page, SOURCE);
});
