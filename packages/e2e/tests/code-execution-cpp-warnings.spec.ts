import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { dragBy } from './helpers/scenario.js';

/**
 * C++ のコンパイルが、利用者のコードと関係の無い警告を端末に出さないことの nightly 検査 (#871)。
 *
 * 成功したコンパイルの診断も端末とマーカーに出す (#708) ので、次の 2 つが C++ の実行のたびに見えていた:
 * - `clang-16: warning: '-x c++' after last input file has no effect` (CppExecutor が `-xc++` を
 *   入力ファイルの後ろに渡していた。C++ として扱わせるのは拡張子 `.cpp` で足りるので渡さない)
 * - libc++ 19 の `#warning "Libc++ only supports Clang 17 and later"` (clang 16 との版の食い違い = #573。
 *   CppExecutor が `-include` するヘッダで、`<__config>` を取り込む間だけ `-W#warnings` を無視させる)
 *
 * 黙らせ方が広すぎないこと (利用者が書いた `#warning` と、利用者のコードの `-Wformat` などの警告が、
 * これまでどおり端末と行のマーカーに出る) も同じファイルで見る。
 *
 * 実行系を外部の配信物から取るので `@nightly` (code-execution-c-python.spec.ts と同じ扱い)。
 * 実行の終わりは状態契約 (`data-exec-state` / `data-exec-run` / `data-exec-outcome`) で読み、
 * ターミナルからは利用者のコードが出した文字列と clang の英語のメッセージだけを読む。
 */

const TERMINAL = '#xterm-container';

/** 実行系の取得・初期化を含む 1 回目の実行の終わりを待つ上限 (CDN の遅い夜を見込む) */
const FIRST_RUN_TIMEOUT_MS = 240_000;

test.describe.configure({ timeout: 360_000 });

// ターミナルは見えている行しか DOM に無い。診断の全体 (警告の有無) を読むため、画面を縦に伸ばして
// ターミナルを広げる (上限は workbench の 6 割。TerminalPanel)
test.use({ viewport: { width: 1280, height: 1600 } });

/**
 * ターミナルのパネルを、リサイズハンドルを上へドラッグして上限まで広げ、出力がすべて見えている
 * (スクロールして隠れた行が無い) ことを確かめる。広げると xterm は隠れていた行を表示に戻す
 */
async function showWholeTerminal(page: Page): Promise<void> {
  await expect(page.locator('#terminal-resize-handle')).toBeVisible();
  await dragBy(page, '#terminal-resize-handle', 0, -1_200);
  await expect
    .poll(() => page.locator(`${TERMINAL} .xterm-viewport`).evaluate((el) => el.scrollHeight - el.clientHeight <= 1))
    .toBe(true);
}

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

/** code を C++ で実行して success で終わることと、marker の出力が端末に出たことを確かめ、端末の文字列を返す */
async function runCppToSuccess(app: EditorApp, code: string, marker: string): Promise<string> {
  const { page } = app;
  await app.setLanguage('cpp');
  await replaceCode(app, code);
  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await showWholeTerminal(page);
  await expect.poll(() => terminalText(page)).toContain(marker);
  return terminalText(page);
}

/** squiggly (実行のマーカー) が付いている行の文字列を、上から順に返す */
async function squigglyLines(page: Page, kind: 'warning' | 'error'): Promise<string[]> {
  const tops = await page
    .locator(`.monaco-editor .squiggly-${kind}`)
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  const viewLines = await page
    .locator('.monaco-editor .view-lines .view-line')
    .evaluateAll((els) =>
      els.map((l) => ({ top: l.getBoundingClientRect().top, text: (l.textContent ?? '').replace(/ /g, ' ') }))
    );
  return tops
    .sort((a, b) => a - b)
    .map((top) => viewLines.find((l) => Math.abs(l.top - top) < 4)?.text ?? `(no line at ${top})`);
}

test('cpp: @nightly <cstdio> だけの hello は C++17 で実行され、端末に警告を 1 つも出さない (#871)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const code = [
    '#include <cstdio>',
    '',
    'int main() {',
    '    std::printf("hello-cpp std=%ld\\n", (long)__cplusplus);',
    '    return 0;',
    '}',
    '',
  ].join('\n');

  const text = await runCppToSuccess(app, code, 'hello-cpp std=');

  // `-xc++` を外しても C++17 のまま (拡張子 .cpp で C++ として扱われ、-std=c++17 が効く)
  expect(text).toContain('hello-cpp std=201703');
  expect(text).not.toContain('after last input file');
  expect(text).not.toContain('Libc++ only supports');
  expect(text).not.toContain('warning:');
  expect(await squigglyLines(page, 'warning')).toEqual([]);
});

test('cpp: @nightly 利用者が書いた #warning とコードの -Wformat の警告は、端末とその行のマーカーに出る (#871)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const code = [
    '#include <cstdio>',
    '#warning "student-warning"',
    '',
    'int main() {',
    '    std::printf("fmt %d\\n", 1.5);',
    '    std::printf("done-cpp\\n");',
    '    return 0;',
    '}',
    '',
  ].join('\n');

  const text = await runCppToSuccess(app, code, 'done-cpp');

  // 利用者の #warning (2 行目) と -Wformat (5 行目) は消さず、libc++ の版の #warning だけが出ない
  expect(text).toMatch(/main\.cpp:2:\d+: warning: "student-warning"/);
  expect(text).toMatch(/main\.cpp:5:\d+: warning: format specifies type 'int'/);
  expect(text).not.toContain('Libc++ only supports');
  expect(text).not.toContain('after last input file');
  await expect
    .poll(() => squigglyLines(page, 'warning'))
    .toEqual(['#warning "student-warning"', '    std::printf("fmt %d\\n", 1.5);']);
});
