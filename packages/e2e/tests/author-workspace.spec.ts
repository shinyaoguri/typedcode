import { test, expect, type Page } from '@playwright/test';
import {
  TWO_PROBLEMS,
  appendToEditor,
  authorRoot,
  dialog,
  documentState,
  editorGroup,
  explorerItem,
  openAuthorFolder,
  openFromExplorer,
  readFolderFile,
  tab,
  waitForAuthorHook,
  waitForOpenFolder,
  writeFolderFileExternally,
} from './helpers/author.js';

/**
 * `/author` の教材フォルダの作問画面 (#795 / #796 / ADR-0051)。
 *
 * ネイティブのフォルダのピッカーは Playwright で操作できないので、OPFS (`navigator.storage.getDirectory()`)
 * のディレクトリハンドルを dev 限定フック `window.__tcTestAuthorWorkspace` で教材フォルダとして渡す
 * (packages/editor/src/authoring/workspace/devWorkspaceHook.ts)。`openInPage` は実際の画面にそのフォルダを
 * 開かせるので、エクスプローラー・タブ・保存・競合の選択は画面の部品で操作し、状態は状態契約の `data-*` で読む
 * (packages/editor/AGENTS.md「状態契約」)。外部での変更は OPFS のファイルへ直接書いて模擬する。
 *
 * OPFS のハンドルは権限が常に granted なので、権限が prompt のときの経路 (ボタンのクリックで requestPermission)
 * はユニットテスト (folderAccess.test.ts) が担う。dev フックを使うので dev サーバ向けの設定でだけ走る
 * (playwright.build.config.ts は production-build.spec だけを選ぶ)。
 */

/** OPFS の中に置くテスト用の教材フォルダ名 (テストごとに作り直す) */
const FOLDER = 'e2e-material-796';

interface HookWindow {
  __tcTestAuthorWorkspace?: {
    open(handle: FileSystemDirectoryHandle): Promise<string>;
    resume(): Promise<{ status: string; name?: string; reason?: string }>;
    list(): Promise<string[]>;
    read(path: string): Promise<string>;
    write(path: string, text: string, overwrite?: boolean): Promise<{ status: string; reason?: string }>;
  };
}

async function saveActive(page: Page): Promise<void> {
  await page.locator('#author-save-btn').click();
}

test('/author: OPFS のフォルダに保存し、読み直した後に前回のフォルダで再開して同じ内容を読める', async ({ page }) => {
  const PATH = '過去問/探索.problem.yaml';
  const CONTENT = 'format: tc-problem/1\nid: 探索\nstatement: 探索.md\n';
  await page.goto('/author');
  await waitForAuthorHook(page);

  const saved = await page.evaluate(
    async ({ folder, path, content }) => {
      const hook = (window as unknown as HookWindow).__tcTestAuthorWorkspace;
      if (!hook) throw new Error('hook missing');
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const dir = await root.getDirectoryHandle(folder, { create: true });
      const name = await hook.open(dir);
      const result = await hook.write(path, content);
      return { name, status: result.status };
    },
    { folder: FOLDER, path: PATH, content: CONTENT }
  );
  expect(saved).toEqual({ name: FOLDER, status: 'saved' });

  await page.reload();
  await waitForAuthorHook(page);
  // 画面も前回のフォルダで再開している
  await waitForOpenFolder(page, FOLDER);

  const resumed = await page.evaluate(async (path) => {
    const hook = (window as unknown as HookWindow).__tcTestAuthorWorkspace;
    if (!hook) throw new Error('hook missing');
    const result = await hook.resume();
    if (result.status !== 'opened') return { result, files: [], text: null };
    return { result, files: await hook.list(), text: await hook.read(path) };
  }, PATH);
  expect(resumed).toEqual({ result: { status: 'opened', name: FOLDER }, files: [PATH], text: CONTENT });
});

test('/author: 何も覚えていなければ起動画面を出す', async ({ page }) => {
  await page.goto('/author');
  await expect(authorRoot(page)).toHaveAttribute('data-workspace-state', 'welcome');
  await expect(page.locator('[data-action="open-folder"]')).toBeVisible();
});

test('/author: 本文と解答例を編集して保存すると元のファイルが更新され、読み直すと前回のフォルダで再開して保存した内容が見える', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, TWO_PROBLEMS);
  await expect(page.locator('#author-explorer [data-role="problem"]')).toHaveCount(2);

  await openFromExplorer(page, 'p1.md', 'statement');
  await appendToEditor(page, '入力の末尾は改行。');
  await saveActive(page);
  await expect(tab(page, 'p1.md')).toHaveAttribute('data-dirty', 'false');
  const statement = (await documentState(page, 'p1.md'))!.text;
  expect(statement).toContain('入力の末尾は改行。');
  expect(await readFolderFile(page, FOLDER, 'p1.md')).toBe(statement);

  await openFromExplorer(page, 'p1-解答.c', 'solution');
  await appendToEditor(page, '/* 解答の注記 */');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(tab(page, 'p1-解答.c')).toHaveAttribute('data-dirty', 'false');
  const solution = (await documentState(page, 'p1-解答.c'))!.text;
  expect(solution).toContain('/* 解答の注記 */');
  expect(await readFolderFile(page, FOLDER, 'p1-解答.c')).toBe(solution);

  await page.reload();
  await waitForAuthorHook(page);
  await waitForOpenFolder(page, FOLDER);
  await openFromExplorer(page, 'p1.md', 'statement');
  expect((await documentState(page, 'p1.md'))?.text).toBe(statement);
  await openFromExplorer(page, 'p1-解答.c', 'solution');
  expect((await documentState(page, 'p1-解答.c'))?.text).toBe(solution);
});

test('/author: 画面から本文だけの問題を作り、初期コード 1・ヒント 2・解答例 2 を足すと、読み直した後もエクスプローラーに並ぶ', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, {});

  await page.locator('#author-explorer [data-action="new-problem"]').click();
  await dialog(page, 'new-problem').locator('[data-field="name"]').fill('合計');
  await dialog(page, 'new-problem').locator('[data-action="ok"]').click();
  await expect(explorerItem(page, '合計.problem.yaml', 'problem')).toBeVisible();
  // 作った本文が開く
  await expect(editorGroup(page)).toHaveAttribute('data-active-path', '合計.md');

  // 既定の名前は画面の言語で変わる (役割の語) ので、名前はテストが決めて入れる
  const steps = [
    ['starter', '合計-初期.c'],
    ['hint', '合計-ヒント.md'],
    ['hint', '合計-ヒント2.md'],
    ['solution', '合計-解答.c'],
    ['solution', '合計-解答2.c'],
  ] as const;
  for (const [index, [role, name]] of steps.entries()) {
    await page.locator('[data-action="add-part"][data-problem-path="合計.problem.yaml"]').click();
    const add = dialog(page, 'add-part');
    await add.locator('[data-field="role"]').selectOption(role);
    await add.locator('[data-field="name"]').fill(name);
    await add.locator('[data-action="ok"]').click();
    await expect(add).toHaveCount(0);
    // 足した要素の分だけ増える (本文 + index + 1)
    await expect(page.locator('#author-explorer .author-explorer-parts [data-explorer-path]')).toHaveCount(index + 2);
  }

  await page.reload();
  await waitForAuthorHook(page);
  await waitForOpenFolder(page, FOLDER);
  const parts = page.locator('#author-explorer .author-explorer-parts [data-explorer-path]');
  await expect(parts).toHaveCount(6);
  const listed = await parts.evaluateAll((items) =>
    items.map((item) => [
      (item as HTMLElement).dataset.role,
      (item as HTMLElement).dataset.explorerPath,
      (item as HTMLElement).dataset.missing ?? 'false',
    ])
  );
  expect(listed).toEqual([
    ['statement', '合計.md', 'false'],
    ['starter', '合計-初期.c', 'false'],
    ['hint', '合計-ヒント.md', 'false'],
    ['hint', '合計-ヒント2.md', 'false'],
    ['solution', '合計-解答.c', 'false'],
    ['solution', '合計-解答2.c', 'false'],
  ]);
});

test('/author: 未保存のタブに印が付いて保存で消え、外部で変わったファイルは上書きせずに選ばせる', async ({ page }) => {
  await openAuthorFolder(page, FOLDER, TWO_PROBLEMS);
  await openFromExplorer(page, 'p1.md', 'statement');

  await appendToEditor(page, 'A');
  await expect(tab(page, 'p1.md')).toHaveAttribute('data-dirty', 'true');
  await expect(authorRoot(page)).toHaveAttribute('data-dirty-count', '1');
  await saveActive(page);
  await expect(tab(page, 'p1.md')).toHaveAttribute('data-dirty', 'false');
  await expect(authorRoot(page)).toHaveAttribute('data-dirty-count', '0');

  // 外部で変わったファイルを保存しようとすると、書かずに選ばせる → 上書きする
  await appendToEditor(page, 'B');
  await writeFolderFileExternally(page, FOLDER, 'p1.md', 'theirs-1\n');
  await saveActive(page);
  await expect(dialog(page, 'conflict')).toBeVisible();
  expect(await readFolderFile(page, FOLDER, 'p1.md')).toBe('theirs-1\n');
  const mine = (await documentState(page, 'p1.md'))!.text;
  await dialog(page, 'conflict').locator('[data-action="overwrite"]').click();
  await expect(tab(page, 'p1.md')).toHaveAttribute('data-dirty', 'false');
  expect(await readFolderFile(page, FOLDER, 'p1.md')).toBe(mine);

  // もう一度: 読み直すと外部の内容になる (手元の編集は捨てる)
  await appendToEditor(page, 'C');
  await writeFolderFileExternally(page, FOLDER, 'p1.md', 'theirs-2\n');
  await saveActive(page);
  await expect(dialog(page, 'conflict')).toBeVisible();
  await dialog(page, 'conflict').locator('[data-action="reload"]').click();
  await expect(tab(page, 'p1.md')).toHaveAttribute('data-dirty', 'false');
  expect(await documentState(page, 'p1.md')).toEqual({
    path: 'p1.md',
    savedText: 'theirs-2\n',
    text: 'theirs-2\n',
    dirty: false,
  });
  expect(await readFolderFile(page, FOLDER, 'p1.md')).toBe('theirs-2\n');
});

test('/author: 同じ文書を左右の群で開き、Markdown は群ごとにプレビューへ切り替えられる', async ({ page }) => {
  await openAuthorFolder(page, FOLDER, TWO_PROBLEMS);
  await openFromExplorer(page, 'p1.md', 'statement');
  await page.locator('#author-split-btn').click();
  await expect(editorGroup(page, 1)).toHaveAttribute('data-active-path', 'p1.md');

  await editorGroup(page, 1).locator('[data-action="view-preview"]').click();
  await expect(editorGroup(page, 1)).toHaveAttribute('data-view', 'preview');
  await expect(editorGroup(page, 0)).toHaveAttribute('data-view', 'edit');

  // 左で打った内容が右のプレビューに出る (モデルは文書ごとに 1 つ)
  await appendToEditor(page, '\n\n追記した段落');
  await expect(editorGroup(page, 1).locator('.author-preview')).toContainText('追記した段落');
  await expect(tab(page, 'p1.md', 1)).toHaveAttribute('data-dirty', 'true');

  // 分割を閉じると 1 つに戻る (右にしか無い文書は無いので確かめない)
  await editorGroup(page, 1).locator('[data-action="close-group"]').click();
  await expect(editorGroup(page, 1)).toBeHidden();
  await expect(tab(page, 'p1.md', 0)).toHaveAttribute('data-dirty', 'true');
});
