import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import {
  countInTerminal,
  enlargeTerminal,
  FIRST_RUN_TIMEOUT_MS,
  replaceLines,
  runAndWait,
  squigglyLines,
  terminalText,
} from './helpers/cExecution.js';

/**
 * C++ のコンパイルが、利用者のコードと関係の無い警告を端末に出さないことの nightly 検査 (#871)。
 *
 * 成功したコンパイルの診断も端末とマーカーに出す (#708) ので、次の 2 つが C++ の実行のたびに見えていた:
 * - `clang-16: warning: '-x c++' after last input file has no effect` (CppExecutor が `-xc++` を
 *   入力ファイルの後ろに渡していた。C++ として扱わせるのは拡張子 `.cpp` で足りるので渡さない)
 * - libc++ 19 の `#warning "Libc++ only supports Clang 17 and later"` (clang 16 との版の食い違い = #573)。
 *   利用者の `#include <cstdio>` の行から出る。CppExecutor が `-include` するヘッダで、`<__config>` を
 *   取り込む間だけ `-W#warnings` を無視させる。`-include` は利用者のソースと stdout の支援コード (#709) の
 *   両方の翻訳単位に掛かるので、どちらからも出ない
 *
 * 黙らせ方が広すぎないこと (利用者が書いた `#warning` と、利用者のコードの `-Wformat` などの警告が、
 * これまでどおり端末と行のマーカーに出る) も同じファイルで見る。
 *
 * 実行系を外部の配信物から取るので `@nightly` (code-execution-c-python.spec.ts と同じ扱い)。
 * ターミナルは見えている行しか読めないので、パネルを広げ (`enlargeTerminal`)、`countInTerminal` で run の
 * 先頭が画面に残っていることを確かめてから数える (警告が無いことを、流れて見えないだけと取り違えないため)。
 */

test.describe.configure({ timeout: 360_000 });
test.use({ viewport: { width: 1280, height: 1400 } });

test('cpp: @nightly <cstdio> だけの hello は C++17 で実行され、端末に警告を 1 つも出さない (#871)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('cpp');
  await replaceLines(app, [
    '#include <cstdio>',
    '',
    'int main() {',
    '    std::printf("hello-cpp std=%ld\\n", (long)__cplusplus);',
    '    return 0;',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  // `-xc++` を外しても C++17 のまま (拡張子 .cpp で C++ として扱われ、-std=c++17 が効く)
  await expect.poll(() => terminalText(page)).toContain('hello-cpp std=201703');
  expect(await countInTerminal(page, /after last input file/), await terminalText(page)).toBe(0);
  expect(await countInTerminal(page, /Libc\+\+ only supports/), await terminalText(page)).toBe(0);
  expect(await countInTerminal(page, /warning:/), await terminalText(page)).toBe(0);
  expect(await squigglyLines(page, 'warning')).toEqual([]);
});

test('cpp: @nightly 利用者が書いた #warning とコードの -Wformat の警告は、端末とその行のマーカーに出る (#871)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('cpp');
  await replaceLines(app, [
    '#include <cstdio>',
    '#warning "student-warning"',
    '',
    'int main() {',
    '    std::printf("fmt %d\\n", 1.5);',
    '    std::printf("done-cpp\\n");',
    '    return 0;',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('done-cpp');

  // 利用者の #warning (2 行目) と -Wformat (5 行目) は 1 回ずつ出て、libc++ の版の #warning だけが出ない
  const text = await terminalText(page);
  expect(await countInTerminal(page, /main\.cpp:2:\d+: warning: "student-warning"/), text).toBe(1);
  expect(await countInTerminal(page, /main\.cpp:5:\d+: warning: format specifies type 'int'/), text).toBe(1);
  expect(await countInTerminal(page, /Libc\+\+ only supports/), text).toBe(0);
  expect(await countInTerminal(page, /after last input file/), text).toBe(0);
  await expect
    .poll(() => squigglyLines(page, 'warning'))
    .toEqual(['#warning "student-warning"', '    std::printf("fmt %d\\n", 1.5);']);
});
