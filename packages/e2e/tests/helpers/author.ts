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

// ============================================================================
// 検証 (#799)
// ============================================================================

/** 偽の検証の入口の対応表の 1 行 (packages/editor/src/authoring/verification/fakeRunner.ts) */
export interface FakeVerificationEntry {
  filename: string;
  stdin?: string;
  outcome?: 'success' | 'runtime-error' | 'timeout' | 'unsupported';
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
}

interface VerifyHookWindow {
  __tcTestAuthorWorkspace?: {
    setFakeVerification(entries: FakeVerificationEntry[] | null): void;
    fakeVerificationCalls(): { filename: string; stdin: string }[];
  };
}

/** 最大値を求める解答例 2 つ (先頭要素で初期化する / 0 で初期化する誤り) とケース 2 つの問題 */
export const MAX_PROBLEM: Record<string, string> = {
  'max.problem.yaml':
    'format: tc-problem/1\nid: max\ntitle: 最大値\nstatement: max.md\nsolutions: [max-first.c, max-zero.c]\ncases: max.cases.yaml\n',
  'max.md': '# 最大値\n',
  'max-first.c': [
    '#include <stdio.h>',
    'int main(void) {',
    '  int n, x, max;',
    '  if (scanf("%d", &n) != 1 || n <= 0) return 1;',
    '  scanf("%d", &max);',
    '  for (int i = 1; i < n; i++) {',
    '    scanf("%d", &x);',
    '    if (x > max) max = x;',
    '  }',
    '  printf("%d\\n", max);',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
  'max-zero.c': [
    '#include <stdio.h>',
    'int main(void) {',
    '  int n, x, max = 0;',
    '  if (scanf("%d", &n) != 1) return 1;',
    '  for (int i = 0; i < n; i++) {',
    '    scanf("%d", &x);',
    '    if (x > max) max = x;',
    '  }',
    '  printf("%d\\n", max);',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
  'max.cases.yaml': [
    'format: tc-cases/1',
    'cases:',
    '  - name: 正の数',
    '    stdin: "3\\n1 8 4\\n"',
    '    stdout: "8\\n"',
    '  - name: 負の数だけ',
    '    stdin: "3\\n-5 -2 -8\\n"',
    '    stdout: "-2\\n"',
    '',
  ].join('\n'),
};

/** 偽の入口で MAX_PROBLEM を走らせたときの「実物どおり」の結果 (0 で初期化した解答だけ負の数で 0 を出す) */
export const MAX_FAKE_RESULTS: FakeVerificationEntry[] = [
  { filename: 'max-first.c', stdin: '3\n1 8 4\n', stdout: '8\n' },
  { filename: 'max-first.c', stdin: '3\n-5 -2 -8\n', stdout: '-2\n' },
  { filename: 'max-zero.c', stdin: '3\n1 8 4\n', stdout: '8\n' },
  { filename: 'max-zero.c', stdin: '3\n-5 -2 -8\n', stdout: '0\n' },
];

/** 検証の実行の入口を偽物にする (null で実物に戻す) */
export async function setFakeVerification(page: Page, entries: FakeVerificationEntry[] | null): Promise<void> {
  await page.evaluate((entries) => {
    const hook = (window as unknown as VerifyHookWindow).__tcTestAuthorWorkspace;
    if (!hook) throw new Error('hook missing');
    hook.setFakeVerification(entries);
  }, entries);
}

/** 偽物の入口が呼ばれた順の (ファイル名, stdin) */
export function fakeVerificationCalls(page: Page): Promise<{ filename: string; stdin: string }[]> {
  return page.evaluate(
    () => (window as unknown as VerifyHookWindow).__tcTestAuthorWorkspace?.fakeVerificationCalls() ?? []
  );
}

/** 検証のパネル */
export function verifyPanel(page: Page): Locator {
  return page.locator('#author-verify-panel');
}

/** 結果表のセル */
export function verifyCell(page: Page, solutionIndex: number, caseIndex: number): Locator {
  return verifyPanel(page).locator(
    `[data-verify-cell][data-solution-index="${solutionIndex}"][data-case-index="${caseIndex}"]`
  );
}

/** 結果表の全セルの判定 (行 = 解答例) */
export async function verifyVerdicts(page: Page): Promise<string[][]> {
  return verifyPanel(page)
    .locator('[data-verify-cell]')
    .evaluateAll((cells) => {
      const rows: string[][] = [];
      for (const cell of cells as HTMLElement[]) {
        const s = Number(cell.dataset.solutionIndex);
        const row = rows[s] ?? [];
        rows[s] = row;
        row[Number(cell.dataset.caseIndex)] = cell.dataset.verdict ?? '';
      }
      return rows;
    });
}

/** エクスプローラーの問題の「検証」を押す */
export async function startVerifyFromExplorer(page: Page, problemPath: string): Promise<void> {
  await page.locator(`#author-explorer [data-action="verify"][data-problem-path="${problemPath}"]`).click();
  await expect(verifyPanel(page)).toBeVisible();
  await expect(verifyPanel(page)).toHaveAttribute('data-problem-path', problemPath);
}

/** 選んだセルの差分の行 ([data-diff, 期待, 実際]) */
export async function verifyDiffRows(page: Page): Promise<string[][]> {
  return page
    .locator('#author-verify-detail [data-diff-line]')
    .evaluateAll((rows) =>
      (rows as HTMLElement[]).map((row) => [
        row.dataset.diff ?? '',
        row.querySelector('[data-diff-side="expected"]')?.textContent ?? '',
        row.querySelector('[data-diff-side="actual"]')?.textContent ?? '',
      ])
    );
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

/** フォームの採用した問題の行の、問題定義のパス (出題順) */
export function adoptedProblems(page: Page): Promise<string[]> {
  return examForm(page)
    .locator('[data-exam-problem]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.examProblem ?? ''));
}
