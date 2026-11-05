import { test, expect, type Page } from '@playwright/test';
import { EditorApp, readAllProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * C (Wasmer + clang) と Python (Pyodide) の実行の nightly スモーク (#589)。
 *
 * JS / TS の実行は code-execution.spec.ts が PR ゲートで見ている。C と Python は実行系を外部の配信物
 * (clang の webc は assets.typedcode.dev、Pyodide は jsDelivr) から取るので PR ゲートには載せず、
 * タイトルに `@nightly` を付けて毎晩だけ回す (playwright.config.ts の grepInvert。NIGHTLY=1 で含まれる)。
 * ここで確かめること:
 * - C と Python の hello が実行され、出力がターミナルに出て、proof の result イベントに success が載る
 * - その proof を含む export が verify-cli (fast) を通る
 * - C のコンパイルエラーが、利用者のコードの行を指す (preamble の行数分ずれない = #489 の回帰)
 *
 * 本番ビルド (`vite preview`) での C の hello は production-build.spec.ts の `@nightly` が見る
 * (@wasmer/sdk の worker の解決は本番ビルドでしか壊れない。editor/AGENTS.md の #364 の項)。
 *
 * 実行の状態は状態契約 (ターミナルのコンテナの `data-exec-state` / `data-exec-run` /
 * `data-exec-outcome`) で読み、翻訳テキストに依存しない。ターミナルの中身は利用者のコードが出した文字列と
 * clang の英語のメッセージだけを読む。初回の実行は実行系の取得と初期化 (clang の webc は約 100 MB) を
 * 含むので、終わりの待ちには明示の timeout を渡す。
 */

const TERMINAL = '#xterm-container';

/** 実行系の取得・初期化を含む 1 回目の実行の終わりを待つ上限 (CDN の遅い夜を見込む) */
const FIRST_RUN_TIMEOUT_MS = 240_000;

test.describe.configure({ timeout: 360_000 });

/** アクティブなタブの中身を code に置き換える (Monaco の自動補完・自動インデントを通らない 1 回の編集で入れる) */
async function replaceCode(app: EditorApp, code: string): Promise<void> {
  await app.focusEditor();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await app.injectCodeBlock(code);
}

async function execState(page: Page) {
  return page.locator(TERMINAL).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

/** Run を押し、その run が終わる (data-exec-run が進み、data-exec-state=idle) まで待って outcome を返す */
async function runAndWait(page: Page, timeout: number): Promise<string | null> {
  const run = (await execState(page)).run + 1;
  await page.locator('#run-code-btn').click();
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', String(run), { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const s = await execState(page);
        return s.run === run && s.state === 'idle';
      },
      { timeout, intervals: [500, 1_000, 2_000] }
    )
    .toBe(true);
  return (await execState(page)).outcome;
}

/** ターミナルの見えている行の文字列 (xterm の DOM レンダラの行) */
async function terminalText(page: Page): Promise<string> {
  return page
    .locator(`${TERMINAL} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/ /g, ' ')).join('\n'));
}

/** export した ZIP の全 proof から、codeExecution の result イベントの (language, outcome, exitCode) を集める */
async function resultEvents(zipPath: string) {
  const all = [...(await readAllProofEvents(zipPath)).values()].flat();
  return all
    .filter((e) => e.type === 'codeExecution' && (e.data as { phase?: string } | null)?.phase === 'result')
    .map((e) => {
      const d = e.data as { language?: string; outcome?: string; exitCode?: number | null };
      return { language: d.language, outcome: d.outcome, exitCode: d.exitCode };
    });
}

/** 実行して出力を確かめ、export が result イベントを持ち verify-cli (fast) を通ることを確かめる */
async function expectHelloRoundTrip(app: EditorApp, language: 'c' | 'python', code: string, expected: string) {
  const { page } = app;
  await replaceCode(app, code);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain(expected);

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  expect(await resultEvents(zipPath)).toEqual([{ language, outcome: 'success', exitCode: 0 }]);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
}

test('c: @nightly hello が clang でコンパイルされて実行され、出力と success の result イベントが残り、verify-cli (fast) を通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  // 計算した値を出す (コードの文字列がそのまま出ているのではなく、実行された証拠にする)
  await expectHelloRoundTrip(
    app,
    'c',
    '#include <stdio.h>\n\nint main(void) {\n    printf("hello-c-%d\\n", 6 * 7);\n    return 0;\n}\n',
    'hello-c-42'
  );
});

test('c: @nightly コンパイルエラーの行番号が利用者のコードの行を指し、マーカーもその行に付く (#489)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  // エラーは 5 行目。preamble (6 行) の分ずれると 11 行目を指すので、その行も実在させておく
  // (ずれた行がモデルの外だとマーカーは最終行に寄せられる = resolveMarkerRange)
  const lines = [
    '#include <stdio.h>',
    '',
    'int main(void) {',
    '    printf("before\\n");',
    '    return undefined_var;',
    '}',
    '// 7',
    '// 8',
    '// 9',
    '// 10',
    '// 11',
  ];
  await replaceCode(app, `${lines.join('\n')}\n`);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('failure');
  // clang のメッセージ自体が元の行を指す (`/workspace/main.c:5:12: error: use of undeclared identifier ...`)
  await expect
    .poll(() => terminalText(page))
    .toMatch(/main\.c:5:\d+: error: use of undeclared identifier 'undefined_var'/);

  // マーカー (squiggly) が `return undefined_var;` の行に付く。C には Monaco 自身の診断が無いので、
  // squiggly は実行のマーカー (parseErrors → resolveMarkerRange) だけ
  await expect
    .poll(async () => {
      const squigglies = await page
        .locator('.monaco-editor .squiggly-error')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      const viewLines = await page
        .locator('.monaco-editor .view-lines .view-line')
        .evaluateAll((els) =>
          els.map((l) => ({ top: l.getBoundingClientRect().top, text: (l.textContent ?? '').replace(/ /g, ' ') }))
        );
      return squigglies.map((top) => viewLines.find((l) => Math.abs(l.top - top) < 4)?.text ?? `(no line at ${top})`);
    })
    .toEqual(['    return undefined_var;']);
});

test('python: @nightly hello が Pyodide で実行され、出力と success の result イベントが残り、verify-cli (fast) を通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await expectHelloRoundTrip(app, 'python', 'print("hello-py-" + str(6 * 7))\n', 'hello-py-42');
});
