import { webcrypto } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import {
  adoptedProblems,
  deleteFolderFileExternally,
  dialog,
  editorGroup,
  examForm,
  openAuthorFolder,
  readFolderFile,
  tab,
} from './helpers/author.js';
import { loadExamFixture } from './helpers/examFixture.js';

/**
 * `/author` の試験定義: 採用問題と出題順の編集・学生プレビュー・配布物の書き出し (#797 / ADR-0051)。
 *
 * 教材フォルダは OPFS に作り、dev フック `__tcTestAuthorWorkspace.openInPage` で画面に開かせる (author-workspace.spec.ts
 * と同じ足場)。フォーム・プレビュー・書き出しのパネルの状態は状態契約の `data-*` で読む (packages/editor/AGENTS.md)。
 *
 * `.tcexam` を `/exam` のゲートで開く 1 本は、テストが作った使い捨ての出題者鍵で署名する。ゲートが信頼する鍵は
 * E2E の dev サーバが fixtures/exam/authority-keys.mjs に差し替えている (exam-keys/vite-plugin.mjs) ので、
 * そのモジュールの応答に、このテストの鍵の公開鍵を足す (page.route。秘密鍵はディスクに置かない)。
 */

const FOLDER = 'e2e-material-797';

/** 3 問の教材 (p1 は初期コードと公開・非公開のケースつき) */
const THREE_PROBLEMS: Record<string, string> = {
  'p1.problem.yaml':
    'format: tc-problem/1\nid: p1\ntitle: 最大値\nstatement: p1.md\nstarter: p1.c\ncases: p1.cases.yaml\n',
  'p1.md': '# 最大値\n',
  'p1.c': 'int main(void) { /* STARTER-797 */ return 0; }\n',
  'p1.cases.yaml': [
    'format: tc-cases/1',
    'cases:',
    '  - name: 例1',
    '    stdin: "3\\n1 8 4\\n"',
    '    stdout: "8\\n"',
    '    public: true',
    '  - name: 非公開',
    '    stdin: "HIDDEN-STDIN"',
    '    stdout: "HIDDEN-STDOUT"',
    '',
  ].join('\n'),
  'p2.problem.yaml': 'format: tc-problem/1\nid: p2\ntitle: 合計\nstatement: p2.md\n',
  'p2.md': '# 合計\n',
  'p3.problem.yaml': 'format: tc-problem/1\nid: p3\ntitle: 探索\nstatement: p3.md\n',
  'p3.md': '# 探索\n',
};

/** 書き出しのパネルを開く */
async function openExportPanel(page: Page): Promise<void> {
  if (await page.locator('#author-settings-panel').isHidden()) await page.locator('#author-settings-toggle').click();
  await expect(page.locator('#author-settings-panel')).toBeVisible();
}

test('/author: 試験を作り、3 問から 2 問を採用して並べ替えて保存すると、学生プレビューがその 2 問をその順で出し、採用しなかった問題はフォルダに残る', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, THREE_PROBLEMS);

  await page.locator('#author-explorer [data-action="new-exam"]').click();
  await dialog(page, 'new-exam').locator('[data-field="name"]').fill('中間');
  await dialog(page, 'new-exam').locator('[data-action="ok"]').click();
  await expect(editorGroup(page)).toHaveAttribute('data-active-path', '中間.exam.yaml');
  // 試験定義はフォームで開く
  await expect(editorGroup(page)).toHaveAttribute('data-view', 'form');
  await expect(examForm(page)).toHaveAttribute('data-state', 'ok');

  await examForm(page).locator('[data-available-problem="p1.problem.yaml"] [data-action="adopt"]').click();
  await examForm(page).locator('[data-available-problem="p3.problem.yaml"] [data-action="adopt"]').click();
  expect(await adoptedProblems(page)).toEqual(['p1.problem.yaml', 'p3.problem.yaml']);

  // 並べ替えはキーボードで: 1 問目の「下へ」にフォーカスして Enter
  await examForm(page).locator('[data-exam-problem="p1.problem.yaml"] [data-action="move-down"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => adoptedProblems(page)).toEqual(['p3.problem.yaml', 'p1.problem.yaml']);
  await expect(examForm(page).locator('[data-exam-problem="p1.problem.yaml"]')).toHaveAttribute('data-index', '1');
  // 未採用の一覧には残りの 1 問だけ
  await expect(examForm(page).locator('[data-available-problem]')).toHaveCount(1);

  await expect(tab(page, '中間.exam.yaml')).toHaveAttribute('data-dirty', 'true');
  await page.locator('#author-save-btn').click();
  await expect(tab(page, '中間.exam.yaml')).toHaveAttribute('data-dirty', 'false');
  const saved = (await readFolderFile(page, FOLDER, '中間.exam.yaml')) ?? '';
  expect(saved.indexOf('p3.problem.yaml')).toBeLessThan(saved.indexOf('p1.problem.yaml'));
  expect(saved).not.toContain('p2.problem.yaml');

  await editorGroup(page).locator('[data-action="view-preview"]').click();
  const preview = editorGroup(page).locator('[data-exam-preview]');
  await expect(preview).toHaveAttribute('data-preview-state', 'ok');
  const shown = await preview
    .locator('[data-preview-problem]')
    .evaluateAll((items) =>
      items.map((item) => [(item as HTMLElement).dataset.previewProblem, (item as HTMLElement).dataset.index])
    );
  expect(shown).toEqual([
    ['p3', '0'],
    ['p1', '1'],
  ]);
  // 公開ケースだけが入出力例になり、非公開のケースは出ない
  const p1 = preview.locator('[data-preview-problem="p1"]');
  await expect(p1.locator('[data-role="starter"]')).toHaveAttribute('data-filename', 'p1.c');
  await expect(p1.locator('[data-example-index]')).toHaveCount(1);
  await expect(preview).not.toContainText('HIDDEN-STDIN');

  // 採用しなかった問題のファイルは教材フォルダに残っている
  expect(await readFolderFile(page, FOLDER, 'p2.problem.yaml')).toBe(THREE_PROBLEMS['p2.problem.yaml']);
  expect(await readFolderFile(page, FOLDER, 'p2.md')).toBe(THREE_PROBLEMS['p2.md']);
});

test('/author: 採用問題の初期コードのファイルを消してから書き出すと、問題とパスを一覧で出し、ダウンロードしない', async ({
  page,
}) => {
  await openAuthorFolder(page, FOLDER, {
    ...THREE_PROBLEMS,
    '授業.exam.yaml': 'format: tc-exam/1\nexamId: lesson\nkind: class\nlanguages: [c]\nproblems: [p1.problem.yaml]\n',
  });
  await deleteFolderFileExternally(page, FOLDER, 'p1.c');

  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await openExportPanel(page);
  await expect(page.locator('#author-export-target')).toHaveValue('授業.exam.yaml');
  await expect(page.locator('#author-build-btn')).toHaveAttribute('data-kind', 'class');
  await page.locator('#author-build-btn').click();

  const error = page.locator('#author-build-error');
  await expect(error).toHaveAttribute('data-reason', 'invalid');
  const issue = error.locator('[data-issues] li');
  await expect(issue).toHaveCount(1);
  await expect(issue).toHaveAttribute('data-issue-kind', 'missing-file');
  await expect(issue).toHaveAttribute('data-problem', 'p1.problem.yaml');
  await expect(issue).toHaveAttribute('data-path', 'p1.c');
  await expect(page.locator('#author-build-btn')).toBeEnabled();
  expect(downloads).toBe(0);
});

test('/author: 書き出した .tcexam を /exam のゲートで開くと、初期コードの入ったタブと公開ケースの入出力例が見える', async ({
  page,
}) => {
  if (!loadExamFixture()) {
    // 鍵の差し替え (exam-keys/vite-plugin.mjs) は fixture があるときだけ働く
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  // このテストだけの出題者鍵。公開鍵をゲートが信頼する鍵の一覧に足す
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const keyId = 'exam-e2e-author-797';
  const entry = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
  };
  let trusted = false;
  await page.route('**/fixtures/exam/authority-keys.mjs*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'LOCAL_EXAM_AUTHORITY_KEYS = [';
    if (!body.includes(marker)) throw new Error(`unexpected authority keys module: ${body.slice(0, 200)}`);
    trusted = true;
    await route.fulfill({ response, body: body.replace(marker, `${marker}${JSON.stringify(entry)},`) });
  });

  await openAuthorFolder(page, FOLDER, {
    ...THREE_PROBLEMS,
    '期末.exam.yaml': 'format: tc-exam/1\nexamId: final-797\nkind: exam\nlanguages: [c]\nproblems: [p1.problem.yaml]\n',
  });
  await openExportPanel(page);
  await expect(page.locator('#author-build-btn')).toHaveAttribute('data-kind', 'exam');
  await page.locator('#author-keyid').fill(keyId);
  await page.locator('#author-jwk').fill(JSON.stringify(privateJwk));
  const code = await page.locator('#author-token').inputValue();

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#author-build-btn').click()]);
  expect(download.suggestedFilename()).toBe('final-797.tcexam');
  const packagePath = test.info().outputPath('final-797.tcexam');
  await download.saveAs(packagePath);

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await app.unlockExam(packagePath, code);
  expect(trusted, 'the gate loaded the authority keys through the route').toBe(true);

  const snapshot = await app.snapshot();
  expect(snapshot.tabs.map((t) => [t.filename, t.content.includes('/* STARTER-797 */')])).toEqual([['p1.c', true]]);
  const examples = page.locator('#problem-examples');
  await expect(examples).toHaveAttribute('data-example-count', '1');
  await expect(examples.locator('[data-example-index="0"] pre[data-role="stdout"]')).toHaveText('8');
  await expect(page.locator('#problem-panel')).not.toContainText('HIDDEN-STDIN');
});
