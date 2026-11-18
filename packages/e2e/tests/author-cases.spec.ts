import { test, expect, type Page } from '@playwright/test';
import {
  caseNames,
  casesForm,
  editorGroup,
  explorerItem,
  openAuthorFolder,
  parseCasesText,
  readFolderFile,
  tab,
  waitForAuthorHook,
  waitForOpenFolder,
} from './helpers/author.js';

/**
 * `/author` のケースファイル (`*.cases.yaml`) のフォーム: 一覧の追加・複製・名前の変更・削除、入力と期待する出力の欄、
 * 末尾の改行の表示、入出力例として配る (`public`) の切り替え (#798 / ADR-0051)。
 *
 * 教材フォルダは OPFS に作り、dev フック `__tcTestAuthorWorkspace.openInPage` で画面に開かせる (author-workspace.spec.ts
 * と同じ足場)。フォームの状態は状態契約の `data-*` で読み (packages/editor/AGENTS.md)、保存したファイルは画面と同じ
 * parser (`parseCasesDefinition`) で読んで値を比べる。
 */

const FOLDER = 'e2e-material-798';

const CASES_PATH = 'p1.cases.yaml';

/** 1 問の教材 (ケース 2 件。1 件目は公開) と、それを採用した試験定義 */
function material(cases: string): Record<string, string> {
  return {
    'p1.problem.yaml': 'format: tc-problem/1\nid: p1\ntitle: 最大値\nstatement: p1.md\ncases: p1.cases.yaml\n',
    'p1.md': '# 最大値\n',
    [CASES_PATH]: cases,
    '中間.exam.yaml': 'format: tc-exam/1\nexamId: midterm\nkind: exam\nlanguages: [c]\nproblems: [p1.problem.yaml]\n',
  };
}

const TWO_CASES = [
  'format: tc-cases/1',
  'cases:',
  '  # 公開する例',
  '  - name: 例1',
  '    stdin: "3\\n1 8 4\\n"',
  '    stdout: "8\\n"',
  '    public: true',
  '  - name: 非公開',
  '    stdin: "1\\n5\\n"',
  '    stdout: "5\\n"',
  '',
].join('\n');

/** エクスプローラーからケースファイルを開き、フォームが読めた状態になるのを待つ */
async function openCases(page: Page): Promise<void> {
  await explorerItem(page, CASES_PATH, 'cases').click();
  await expect(editorGroup(page)).toHaveAttribute('data-active-path', CASES_PATH);
  await expect(editorGroup(page)).toHaveAttribute('data-view', 'form');
  await expect(casesForm(page)).toHaveAttribute('data-state', 'ok');
}

function caseRow(page: Page, name: string) {
  return casesForm(page).locator(`[data-case-index][data-case-name="${name}"]`);
}

async function selectCase(page: Page, name: string): Promise<void> {
  await caseRow(page, name).locator('[data-action="select-case"]').click();
  await expect(caseRow(page, name)).toHaveAttribute('data-selected', 'true');
}

async function save(page: Page): Promise<void> {
  await page.locator('#author-save-btn').click();
  await expect(tab(page, CASES_PATH)).toHaveAttribute('data-dirty', 'false');
}

async function savedCases(page: Page) {
  return parseCasesText(page, (await readFolderFile(page, FOLDER, CASES_PATH)) ?? '');
}

async function reopen(page: Page): Promise<void> {
  await page.reload();
  await waitForAuthorHook(page);
  await waitForOpenFolder(page, FOLDER);
  await openCases(page);
}

test('/author: ケースを追加・複製・改名・削除して保存すると YAML が更新され、読み直すと同じ一覧が出る', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, material(TWO_CASES));
  await openCases(page);
  expect(await caseNames(page)).toEqual(['例1', '非公開']);
  await expect(casesForm(page)).toHaveAttribute('data-case-count', '2');

  // 追加はキーボードで: 足したケースが選ばれ、名前の欄にフォーカスが移る
  await casesForm(page).locator('[data-action="add-case"]').focus();
  await page.keyboard.press('Enter');
  await expect(casesForm(page)).toHaveAttribute('data-case-count', '3');
  const nameField = casesForm(page).locator('[data-field="case-name"]');
  await expect(nameField).toBeFocused();
  const added = await nameField.inputValue();
  expect(added).not.toBe('');
  await expect(casesForm(page).locator('[data-case-index="2"]')).toHaveAttribute('data-selected', 'true');

  // 複製は元の直後に入り、写しが選ばれる
  await selectCase(page, '例1');
  await casesForm(page).locator('[data-action="duplicate-case"]').click();
  await expect(casesForm(page).locator('[data-case-index="1"]')).toHaveAttribute('data-selected', 'true');
  const copied = await nameField.inputValue();
  expect(await caseNames(page)).toEqual(['例1', copied, '非公開', added]);

  // 写しを改名する
  await nameField.fill('例1-別解');
  await expect(caseRow(page, '例1-別解')).toHaveAttribute('data-case-index', '1');

  // 削除すると隣のケースが選ばれる
  await selectCase(page, '非公開');
  await casesForm(page).locator('[data-action="delete-case"]').click();
  expect(await caseNames(page)).toEqual(['例1', '例1-別解', added]);
  await expect(caseRow(page, added)).toHaveAttribute('data-selected', 'true');

  await expect(tab(page, CASES_PATH)).toHaveAttribute('data-dirty', 'true');
  await save(page);
  const saved = await savedCases(page);
  expect(saved.map((c) => c.name)).toEqual(['例1', '例1-別解', added]);
  // 写しは値・public・match が元と同じ
  expect(saved[1]).toEqual({ ...saved[0], name: '例1-別解' });
  expect(saved[2]).toEqual({ name: added, stdin: '', stdout: '', public: false, match: 'trim' });
  // 残したケースのコメントはそのケースに付いたまま
  expect(await readFolderFile(page, FOLDER, CASES_PATH)).toContain('# 公開する例\n  - name: 例1\n');

  await reopen(page);
  expect(await caseNames(page)).toEqual(['例1', '例1-別解', added]);
});

test('/author: 先頭の空白・空行・末尾の改行 2 個を含む入力を入れて保存すると、読み直した欄とファイルの値がそのまま同じ', async ({
  page,
}) => {
  const value = '  3\n\n   1 8 4\n\t\n\n';
  await openAuthorFolder(page, FOLDER, material(TWO_CASES));
  await openCases(page);
  await selectCase(page, '非公開');

  const stdin = casesForm(page).locator('[data-field="case-stdin"]');
  await stdin.fill(value);
  const trailing = casesForm(page).locator('[data-trailing-newlines="stdin"]');
  await expect(trailing).toHaveAttribute('data-count', '2');
  // 期待する出力の欄は末尾の改行 1 個 ("5\n")
  await expect(casesForm(page).locator('[data-trailing-newlines="stdout"]')).toHaveAttribute('data-count', '1');
  // 末尾の改行を消すと なし (0)
  await casesForm(page).locator('[data-field="case-stdout"]').fill('5');
  await expect(casesForm(page).locator('[data-trailing-newlines="stdout"]')).toHaveAttribute('data-count', '0');

  await save(page);
  const saved = await savedCases(page);
  expect(saved[1]).toMatchObject({ name: '非公開', stdin: value, stdout: '5' });
  // 触っていないケースはそのまま
  expect(saved[0]).toEqual({ name: '例1', stdin: '3\n1 8 4\n', stdout: '8\n', public: true, match: 'trim' });

  await reopen(page);
  await selectCase(page, '非公開');
  await expect(stdin).toHaveValue(value);
  await expect(trailing).toHaveAttribute('data-count', '2');
});

test('/author: 入出力例として配るを切り替えて保存すると、試験定義の学生プレビューの入出力例に出る・出ないが切り替わる', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, material(TWO_CASES));
  const preview = editorGroup(page).locator('[data-exam-preview]');
  const examples = preview.locator('[data-preview-problem="p1"] [data-example-index]');
  const showPreview = async () => {
    await explorerItem(page, '中間.exam.yaml').click();
    await editorGroup(page).locator('[data-action="view-preview"]').click();
    await expect(preview).toHaveAttribute('data-preview-state', 'ok');
  };

  await showPreview();
  await expect(examples).toHaveCount(1);

  // 2 件目も配る
  await openCases(page);
  await selectCase(page, '非公開');
  await casesForm(page).locator('[data-field="case-public"]').check();
  await expect(caseRow(page, '非公開')).toHaveAttribute('data-public', 'true');
  await save(page);
  expect((await savedCases(page)).map((c) => c.public)).toEqual([true, true]);
  await showPreview();
  await expect(examples).toHaveCount(2);

  // 2 件とも配らない
  await openCases(page);
  for (const name of ['例1', '非公開']) {
    await selectCase(page, name);
    await casesForm(page).locator('[data-field="case-public"]').uncheck();
    await expect(caseRow(page, name)).toHaveAttribute('data-public', 'false');
  }
  await save(page);
  await showPreview();
  await expect(examples).toHaveCount(0);
});

test('/author: CRLF を含む値は、選び直しやフォーカスの出入りでは書き換えず、別の欄を編集して保存してもそのまま残る', async ({
  page,
}) => {
  const crlf = [
    'format: tc-cases/1',
    'cases:',
    '  - name: 改行',
    '    stdin: "a\\r\\nb\\r\\n"',
    '    stdout: "x\\r\\n"',
    '  - name: 次',
    '    stdin: ""',
    '    stdout: ""',
    '',
  ].join('\n');
  await openAuthorFolder(page, FOLDER, material(crlf));
  await openCases(page);
  await expect(casesForm(page).locator('[data-crlf-note="stdin"]')).toBeVisible();
  await expect(casesForm(page).locator('[data-trailing-newlines="stdin"]')).toHaveAttribute('data-count', '1');

  // 欄に入って出る・別のケースを選んで戻るだけでは、文書を書き換えない
  await casesForm(page).locator('[data-field="case-stdin"]').focus();
  await page.keyboard.press('Tab');
  await selectCase(page, '次');
  await selectCase(page, '改行');
  await expect(tab(page, CASES_PATH)).toHaveAttribute('data-dirty', 'false');

  // 名前と照合だけを変える
  await casesForm(page).locator('[data-field="case-name"]').fill('改行あり');
  await casesForm(page).locator('[data-field="case-match"]').selectOption('exact');
  await expect(caseRow(page, '改行あり')).toHaveAttribute('data-match', 'exact');
  await save(page);
  expect((await savedCases(page))[0]).toEqual({
    name: '改行あり',
    stdin: 'a\r\nb\r\n',
    stdout: 'x\r\n',
    public: false,
    match: 'exact',
  });
});

test('/author: ケースの名前を空や重複にすると文書を書き換えずに誤りを出す', async ({ page }) => {
  await openAuthorFolder(page, FOLDER, material(TWO_CASES));
  await openCases(page);
  const name = casesForm(page).locator('[data-field="case-name"]');
  const error = casesForm(page).locator('[data-field-error="case-name"]');

  await name.fill('非公開');
  await expect(error).toHaveAttribute('data-reason', 'duplicate-name');
  await name.fill('');
  await expect(error).toHaveAttribute('data-reason', 'empty-name');
  await expect(tab(page, CASES_PATH)).toHaveAttribute('data-dirty', 'false');
  await name.fill('例A');
  await expect(error).toBeHidden();
  expect(await caseNames(page)).toEqual(['例A', '非公開']);
  await expect(tab(page, CASES_PATH)).toHaveAttribute('data-dirty', 'true');
});

test('/author: 読めないケースファイルは理由を出し、テキストの表示に切り替えられる', async ({ page }) => {
  await openAuthorFolder(page, FOLDER, material('format: tc-cases/1\ncases:\n  - name: ""\n    stdin: ""\n'));
  await explorerItem(page, CASES_PATH, 'cases').click();
  await expect(casesForm(page)).toHaveAttribute('data-state', 'invalid');
  await casesForm(page).locator('[data-action="view-edit"]').click();
  await expect(editorGroup(page)).toHaveAttribute('data-view', 'edit');
});
