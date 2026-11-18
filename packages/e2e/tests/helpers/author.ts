import { expect, type Locator, type Page } from '@playwright/test';
import { BOOT_TIMEOUT_MS } from './app.js';

/**
 * `/author` (作問画面) を E2E から操作する足場 (#796)。
 *
 * ネイティブのフォルダのピッカーは Playwright で操作できないので、OPFS (`navigator.storage.getDirectory()`) に
 * 教材フォルダを作り、dev 限定フック `window.__tcTestAuthorWorkspace.openInPage` で実際の画面に開かせる
 * (packages/editor/src/authoring/workspace/devWorkspaceHook.ts)。画面の状態は状態契約の `data-*` で読み、
 * 文書のテキストはフックの `document(path)` で読む (Monaco の表示は空白・折り返しで照合しにくい)。
 * 外部での変更は、テストが OPFS のファイルに直接書いて模擬する。
 */

export interface AuthorDocumentState {
  path: string;
  savedText: string;
  text: string;
  dirty: boolean;
}

interface HookWindow {
  __tcTestAuthorWorkspace?: {
    openInPage(handle: FileSystemDirectoryHandle): Promise<string>;
    document(path: string): AuthorDocumentState | null;
  };
}

/** 2 問を置いた教材フォルダ (1 問目は本文と解答例、2 問目は本文だけ) */
export const TWO_PROBLEMS: Record<string, string> = {
  'p1.problem.yaml': 'format: tc-problem/1\nid: p1\ntitle: 最大値\nstatement: p1.md\nsolutions: [p1-解答.c]\n',
  'p1.md': '# 最大値\n\n数列の最大値を出力する。\n',
  'p1-解答.c': 'int main(void) { return 0; }\n',
  'p2.problem.yaml': 'format: tc-problem/1\nid: p2\ntitle: 合計\nstatement: p2.md\n',
  'p2.md': '# 合計\n',
};

export async function waitForAuthorHook(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as HookWindow).__tcTestAuthorWorkspace !== undefined, null, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

/** `/author` の root (`#author-root`) */
export function authorRoot(page: Page): Locator {
  return page.locator('#author-root');
}

/** 作業画面になり、このフォルダを開いているのを待つ */
export async function waitForOpenFolder(page: Page, folder: string): Promise<void> {
  await expect(authorRoot(page)).toHaveAttribute('data-workspace-state', 'open', { timeout: BOOT_TIMEOUT_MS });
  await expect(authorRoot(page)).toHaveAttribute('data-folder-name', folder);
}

/** OPFS に教材フォルダを作り直して (サブフォルダも作る) 画面に開かせる */
export async function openAuthorFolder(page: Page, folder: string, files: Record<string, string>): Promise<void> {
  if (!page.url().includes('/author')) await page.goto('/author');
  await waitForAuthorHook(page);
  await page.evaluate(
    async ({ folder, files }) => {
      const hook = (window as unknown as HookWindow).__tcTestAuthorWorkspace;
      if (!hook) throw new Error('hook missing');
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const dir = await root.getDirectoryHandle(folder, { create: true });
      for (const [path, text] of Object.entries(files)) {
        const segments = path.split('/');
        let parent = dir;
        for (const segment of segments.slice(0, -1))
          parent = await parent.getDirectoryHandle(segment, { create: true });
        const file = await parent.getFileHandle(segments[segments.length - 1]!, { create: true });
        const writable = await file.createWritable();
        await writable.write(text);
        await writable.close();
      }
      await hook.openInPage(dir);
    },
    { folder, files }
  );
  await waitForOpenFolder(page, folder);
}

/** OPFS の教材フォルダのファイルを読む (無ければ null) */
export function readFolderFile(page: Page, folder: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ folder, path }) => {
      try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
        const segments = path.split('/');
        for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
        const file = await (await dir.getFileHandle(segments[segments.length - 1]!)).getFile();
        return await file.text();
      } catch {
        return null;
      }
    },
    { folder, path }
  );
}

/** 画面の外 (別のエディタ・同期ソフト) での書き込みの代役 */
export async function writeFolderFileExternally(page: Page, folder: string, path: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ folder, path, text }) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      const segments = path.split('/');
      for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
      const handle = await dir.getFileHandle(segments[segments.length - 1]!);
      const before = (await handle.getFile()).lastModified;
      // 読んだときと同じ lastModified にならないよう、時計が進むのを待ってから書く
      while (Date.now() <= before) await new Promise((resolve) => setTimeout(resolve, 5));
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    { folder, path, text }
  );
}

/** 画面が開いている文書の状態 */
export function documentState(page: Page, path: string): Promise<AuthorDocumentState | null> {
  return page.evaluate(
    (path) => (window as unknown as HookWindow).__tcTestAuthorWorkspace?.document(path) ?? null,
    path
  );
}

/** エクスプローラーの項目 */
export function explorerItem(page: Page, path: string, role?: string): Locator {
  const roleSelector = role ? `[data-role="${role}"]` : '';
  return page.locator(`#author-explorer [data-explorer-path="${path}"]${roleSelector}`);
}

/** エディタ群 */
export function editorGroup(page: Page, index: 0 | 1 = 0): Locator {
  return page.locator(`#author-groups [data-editor-group="${index}"]`);
}

/** タブ */
export function tab(page: Page, path: string, group: 0 | 1 = 0): Locator {
  return page.locator(`#author-groups .editor-tab[data-path="${path}"][data-group="${group}"]`);
}

/** エクスプローラーから文書を開き、群 0 のアクティブな文書になるのを待つ */
export async function openFromExplorer(page: Page, path: string, role?: string): Promise<void> {
  await explorerItem(page, path, role).click();
  await expect(editorGroup(page)).toHaveAttribute('data-active-path', path);
  await expect(editorGroup(page).locator('.view-lines')).toBeVisible();
}

/** 群 0 のエディタの末尾に文字を足す (Monaco の自動補完を通さないよう insertText で入れる) */
export async function appendToEditor(page: Page, text: string): Promise<void> {
  const editor = editorGroup(page).locator('.monaco-editor');
  await editor.locator('.view-lines').click();
  // 文書の末尾へ (Ctrl/Cmd+End は OS で割り当てが違うので、Monaco のコマンドに頼らず末尾の行をクリックしてから End)
  await editor.locator('.view-line').last().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(text);
}

/** 開いているダイアログ (状態契約の data-dialog) */
export function dialog(page: Page, name: string): Locator {
  return page.locator(`.modal-overlay[data-dialog="${name}"]:not(.hidden)`);
}

/** 画面の外 (別のエディタ・エクスプローラー) での削除の代役 (#797) */
export async function deleteFolderFileExternally(page: Page, folder: string, path: string): Promise<void> {
  await page.evaluate(
    async ({ folder, path }) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      const segments = path.split('/');
      for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
      await dir.removeEntry(segments[segments.length - 1]!);
    },
    { folder, path }
  );
}

/** 群 0 の試験定義のフォーム (#797) */
export function examForm(page: Page): Locator {
  return editorGroup(page).locator('[data-exam-form]');
}

interface PickerHookWindow {
  __tcTestAuthorWorkspace?: {
    openInPage(handle: FileSystemDirectoryHandle): Promise<string>;
    setNextPickedDirectory(handle: FileSystemDirectoryHandle | null): void;
  };
}

/** OPFS にフォルダを作り直してファイルを置く (画面には開かない。コピー先など。#800) */
export async function createOpfsFolder(page: Page, folder: string, files: Record<string, string>): Promise<void> {
  await page.evaluate(
    async ({ folder, files }) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const dir = await root.getDirectoryHandle(folder, { create: true });
      for (const [path, text] of Object.entries(files)) {
        const segments = path.split('/');
        let parent = dir;
        for (const segment of segments.slice(0, -1))
          parent = await parent.getDirectoryHandle(segment, { create: true });
        const file = await parent.getFileHandle(segments[segments.length - 1]!, { create: true });
        const writable = await file.createWritable();
        await writable.write(text);
        await writable.close();
      }
    },
    { folder, files }
  );
}

/** OPFS のフォルダのファイルの一覧 (サブフォルダを含む相対パス、辞書順。#800) */
export function listFolderFiles(page: Page, folder: string): Promise<string[]> {
  return page.evaluate(async (folder) => {
    const paths: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        if (entry.kind === 'directory') await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
        else paths.push(`${prefix}${entry.name}`);
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(folder), '');
    return paths.sort();
  }, folder);
}

/** 画面が次に開くフォルダのピッカーの結果を、OPFS のこのフォルダに差し替える (dev フック。#800) */
export async function setNextPickedFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (folder) => {
    const hook = (window as unknown as PickerHookWindow).__tcTestAuthorWorkspace;
    if (!hook) throw new Error('hook missing');
    hook.setNextPickedDirectory(await (await navigator.storage.getDirectory()).getDirectoryHandle(folder));
  }, folder);
}

/** OPFS に既にあるフォルダを、作り直さずに画面に開かせる (#800) */
export async function openExistingFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (folder) => {
    const hook = (window as unknown as PickerHookWindow).__tcTestAuthorWorkspace;
    if (!hook) throw new Error('hook missing');
    await hook.openInPage(await (await navigator.storage.getDirectory()).getDirectoryHandle(folder));
  }, folder);
  await waitForOpenFolder(page, folder);
}

/** 群 0 のケースファイルのフォーム (#798) */
export function casesForm(page: Page): Locator {
  return editorGroup(page).locator('[data-cases-form]');
}

/** ケースファイルのフォームの一覧の名前 (並び順) */
export function caseNames(page: Page): Promise<string[]> {
  return casesForm(page)
    .locator('[data-case-index]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.caseName ?? ''));
}

export interface ParsedCase {
  name: string;
  stdin: string;
  stdout: string;
  public: boolean;
  match: string;
}

/**
 * ケースファイルのテキストを、画面と同じ parser (`authoring/workspace/definitions.ts` の `parseCasesDefinition`) で読む
 * (#798)。e2e は yaml を依存に持たないので、dev サーバが配る editor のモジュールをページの中で import する。読めなければ例外
 */
export async function parseCasesText(page: Page, text: string): Promise<ParsedCase[]> {
  const result = (await page.evaluate(
    `import('/src/authoring/workspace/definitions.ts').then((m) => m.parseCasesDefinition(${JSON.stringify(text)}))`
  )) as { ok: true; value: ParsedCase[] } | { ok: false; issues: unknown };
  if (!result.ok) throw new Error(`cases file is not readable: ${JSON.stringify(result.issues)}`);
  return result.value;
}

/** フォームの採用した問題の行の、問題定義のパス (出題順) */
export function adoptedProblems(page: Page): Promise<string[]> {
  return examForm(page)
    .locator('[data-exam-problem]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.examProblem ?? ''));
}
