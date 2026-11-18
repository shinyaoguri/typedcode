import { test, expect, type Page } from '@playwright/test';
import {
  MAX_FAKE_RESULTS,
  MAX_PROBLEM,
  TWO_PROBLEMS,
  fakeVerificationCalls,
  openAuthorFolder,
  setFakeVerification,
  startVerifyFromExplorer,
  verifyCell,
  verifyDiffRows,
  verifyPanel,
  verifyVerdicts,
} from './helpers/author.js';

/**
 * `/author` の教員用の一括検証の画面 (#799 / ADR-0051 Decision 6)。
 *
 * エクスプローラーの問題ごとの「検証」で、下のパネル (ターミナルの隣) に解答例 × テストケースの結果表を出す。
 * 状態は状態契約 (`#author-verify-panel` の `data-verify-state` / `data-problem-path` / `data-verify-reason`、
 * セルの `data-verdict`、差分の行の `data-diff`) で読む (packages/editor/AGENTS.md「状態契約」)。
 *
 * PR ごとのテストは実物のコンパイラを使わず、dev 限定フックの `setFakeVerification` で実行の入口を偽物 (対応表どおりに
 * 結果を返す。`hang` は中止まで終わらない) に差し替える。実物の C (Wasmer + clang) と Python (Pyodide) で回す
 * テストはタイトルに `@nightly` を付けて毎晩だけ回す (外部の配信物を取るので PR ゲートに載せない。
 * code-execution-c-python.spec.ts と同じ扱い)。
 */

const FOLDER = 'e2e-material-799';

async function openWithFake(page: Page, files: Record<string, string>, fake = MAX_FAKE_RESULTS): Promise<void> {
  await openAuthorFolder(page, FOLDER, files);
  await setFakeVerification(page, fake);
}

test('/author: 問題の「検証」で下のパネルに解答例 × ケースの表が出て、セルが実行の結果どおりの判定になる', async ({
  page,
}) => {
  await openWithFake(page, MAX_PROBLEM);
  await startVerifyFromExplorer(page, 'max.problem.yaml');

  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done');
  expect(await verifyVerdicts(page)).toEqual([
    ['match', 'match'],
    ['match', 'mismatch'],
  ]);
  // 行見出しは解答例のファイル名、列見出しはケース名
  await expect(verifyPanel(page).locator('tbody th')).toHaveText(['max-first.c', 'max-zero.c']);
  await expect(verifyPanel(page).locator('thead th').nth(1)).toHaveText('正の数');
  await expect(page.locator('#author-bottom')).toHaveAttribute('data-bottom-view', 'verify');
});

test('/author: 不一致のセルを選ぶと、期待と実際の出力が行ごとに並び、違う行に印が付く', async ({ page }) => {
  await openWithFake(page, MAX_PROBLEM);
  await startVerifyFromExplorer(page, 'max.problem.yaml');
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done');

  await verifyCell(page, 1, 1).click();
  await expect(verifyCell(page, 1, 1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#author-verify-detail')).toHaveAttribute('data-case-index', '1');
  expect(await verifyDiffRows(page)).toEqual([['different', '-2', '0']]);

  // 一致のセルは違う行が無い
  await verifyCell(page, 0, 1).click();
  expect(await verifyDiffRows(page)).toEqual([['same', '-2', '-2']]);
});

test('/author: 実行中に中止すると残りのケースを走らせずに aborted になり、検証中はターミナルの実行ボタンが使えない', async ({
  page,
}) => {
  await openWithFake(page, MAX_PROBLEM, [
    { filename: 'max-first.c', stdin: '3\n1 8 4\n', stdout: '8\n' },
    { filename: 'max-first.c', stdin: '3\n-5 -2 -8\n', hang: true },
    { filename: 'max-zero.c', stdout: '8\n' },
  ]);
  await startVerifyFromExplorer(page, 'max.problem.yaml');

  await expect(verifyCell(page, 0, 1)).toHaveAttribute('data-verdict', 'running');
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'running');
  await expect(page.locator('#author-run-btn')).toBeDisabled();
  await expect(verifyPanel(page).locator('[data-action="verify-start"]')).toBeDisabled();

  await verifyPanel(page).locator('[data-action="verify-abort"]').click();
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'aborted');
  expect(await verifyVerdicts(page)).toEqual([
    ['match', 'pending'],
    ['pending', 'pending'],
  ]);
  expect((await fakeVerificationCalls(page)).map((call) => call.filename)).toEqual(['max-first.c', 'max-first.c']);
  // 中止の後は実行ボタンも、もう一度の検証も使える
  await expect(page.locator('#author-run-btn')).toBeEnabled();
  await expect(verifyPanel(page).locator('[data-action="verify-start"]')).toBeEnabled();
});

test('/author: 解答例もケースも無い問題の「検証」は、実行せずに理由をパネルに出す', async ({ page }) => {
  await openWithFake(page, TWO_PROBLEMS);
  await startVerifyFromExplorer(page, 'p2.problem.yaml');
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'blocked');
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-reason', 'no-solutions');
  await expect(verifyPanel(page).locator('[data-verify-cell]')).toHaveCount(0);
  expect(await fakeVerificationCalls(page)).toEqual([]);
});

test('/author: 下のパネルはターミナルと検証を切り替えられ、ターミナルの状態契約はそのまま残る', async ({ page }) => {
  await openWithFake(page, MAX_PROBLEM);
  await startVerifyFromExplorer(page, 'max.problem.yaml');
  await page.locator('#author-bottom [data-action="bottom-terminal"]').click();
  await expect(page.locator('#author-bottom')).toHaveAttribute('data-bottom-view', 'terminal');
  await expect(verifyPanel(page)).toBeHidden();
  await expect(page.locator('#author-terminal-wrap')).toBeVisible();
  await page.locator('#author-bottom [data-action="bottom-verify"]').click();
  await expect(verifyPanel(page)).toBeVisible();
  // 表は切り替えても残っている
  await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done');
});

// ============================================================================
// @nightly: 実物の C (Wasmer + clang) と Python (Pyodide)
// ============================================================================

/** 実行系の取得・初期化 (clang の webc は約 100 MB) を含む検証の終わりを待つ上限 */
const REAL_RUN_TIMEOUT_MS = 300_000;

test.describe('実物の実行系', () => {
  test.describe.configure({ timeout: 420_000 });

  /** 負の数だけのケース 1 つ */
  const NEGATIVE_ONLY =
    'format: tc-cases/1\ncases:\n  - name: 負の数だけ\n    stdin: "3\\n-5 -2 -8\\n"\n    stdout: "-2\\n"\n';

  test('/author: @nightly 0 で初期化した C の解答は負の数だけのケースで不一致、先頭要素で初期化した解答は一致になり、差分に期待 -2 と実際 0 が見える', async ({
    page,
  }) => {
    await openAuthorFolder(page, FOLDER, { ...MAX_PROBLEM, 'max.cases.yaml': NEGATIVE_ONLY });
    await startVerifyFromExplorer(page, 'max.problem.yaml');
    await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done', { timeout: REAL_RUN_TIMEOUT_MS });
    expect(await verifyVerdicts(page)).toEqual([['match'], ['mismatch']]);

    await verifyCell(page, 1, 0).click();
    expect(await verifyDiffRows(page)).toEqual([['different', '-2', '0']]);
  });

  test('/author: @nightly 無限ループする C の解答は時間切れになり、その後も画面を操作できる', async ({ page }) => {
    await openAuthorFolder(page, FOLDER, {
      'loop.problem.yaml':
        'format: tc-problem/1\nid: loop\nstatement: loop.md\nsolutions: [loop.c]\ncases: loop.cases.yaml\n',
      'loop.md': '# ループ\n',
      'loop.c': 'int main(void) {\n  volatile int x = 0;\n  while (1) { x++; }\n  return 0;\n}\n',
      'loop.cases.yaml': 'format: tc-cases/1\ncases:\n  - name: 何か\n    stdin: ""\n    stdout: "x\\n"\n',
    });
    await startVerifyFromExplorer(page, 'loop.problem.yaml');
    await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done', { timeout: REAL_RUN_TIMEOUT_MS });
    expect(await verifyVerdicts(page)).toEqual([['timeout']]);

    // 画面は固まっていない: ターミナルに切り替えられ、もう一度検証を始められる
    await page.locator('#author-bottom [data-action="bottom-terminal"]').click();
    await expect(page.locator('#author-terminal-wrap')).toBeVisible();
    await page.locator('#author-bottom [data-action="bottom-verify"]').click();
    await verifyPanel(page).locator('[data-action="verify-start"]').click();
    await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'running');
    await verifyPanel(page).locator('[data-action="verify-abort"]').click();
    await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'aborted');
  });

  test('/author: @nightly Python の解答例も stdin を読んで一致し、最後の式の値が出力に混ざらない', async ({ page }) => {
    await openAuthorFolder(page, FOLDER, {
      'max.problem.yaml':
        'format: tc-problem/1\nid: max\nstatement: max.md\nsolutions: [max.py]\ncases: max.cases.yaml\n',
      'max.md': '# 最大値\n',
      'max.py': 'n = int(input())\nnums = list(map(int, input().split()))\nprint(max(nums))\nmax(nums)\n',
      'max.cases.yaml': NEGATIVE_ONLY,
    });
    await startVerifyFromExplorer(page, 'max.problem.yaml');
    await expect(verifyPanel(page)).toHaveAttribute('data-verify-state', 'done', { timeout: REAL_RUN_TIMEOUT_MS });
    expect(await verifyVerdicts(page)).toEqual([['match']]);
    await verifyCell(page, 0, 0).click();
    expect(await verifyDiffRows(page)).toEqual([['same', '-2', '-2']]);
  });
});
