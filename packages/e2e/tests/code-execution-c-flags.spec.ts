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
 * C の固定のコンパイルフラグ (`C_COMPILE_FLAGS` = `-std=c17 -Wall -Wextra -Wpedantic
 * -Werror=implicit-function-declaration -O0`。#710) が、本物の clang 16 (Wasmer) に効いていることの nightly 検査。
 *
 * unit (`CExecutor.test.ts` の `fixed C compile flags (#710)`) は偽の SDK で、clang に渡す引数が定数と一致し、
 * C++ に混ざらないことを固定している。ここでは実物のコンパイラで次を確かめる:
 * - 模範解答 (hello) が警告なしにコンパイル・実行される。規格は C17 の厳密モード (`__STDC_VERSION__` = 201710 で
 *   `__STRICT_ANSI__` が立つ = `-std=gnu17` ではない) で、最適化はしていない (`__OPTIMIZE__` が無い = `-O0`)。
 *   stdout の支援コード (#709) の翻訳単位も、同じフラグで警告を出さない
 * - 未使用の変数 (`-Wall`)・printf の書式の不一致・未使用の引数 (`-Wextra`) は警告で、実行は success のまま
 * - 宣言の無い関数の呼び出しはエラーで、プログラムを実行しない。clang 16 は C99 以降でこれを既定でエラーにするので、
 *   今の webc では `-Werror=implicit-function-declaration` の有無はこの検査に出ない (既定が変わってもエラーのままにするフラグ)
 *
 * clang の webc を外部 (assets.typedcode.dev) から取るので PR ゲートには載せず `@nightly` にする
 * (playwright.config.ts の grepInvert。NIGHTLY=1 で含まれる)。C++ のフラグは #710 の範囲外で変えていない。
 */

test.describe.configure({ timeout: 360_000 });
// 1 回目の run は実行系の初期化の行と診断・出力を合わせて行数が多い。ターミナルを広げても run の先頭が流れないよう、
// 画面を高くしておく (code-execution-c-diagnostics.spec.ts と同じ)
test.use({ viewport: { width: 1280, height: 1400 } });

test('c: @nightly 模範解答の hello は C17 の厳密モード・最適化なしで、警告を 1 つも出さずにコンパイル・実行される (#710)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    '',
    '#ifdef __STRICT_ANSI__',
    '#define STRICT 1',
    '#else',
    '#define STRICT 0',
    '#endif',
    '#ifdef __OPTIMIZE__',
    '#define OPTIMIZED 1',
    '#else',
    '#define OPTIMIZED 0',
    '#endif',
    '',
    'int main(void) {',
    '    printf("hello-%d std=%ld strict=%d optimized=%d\\n", 6 * 7, __STDC_VERSION__, STRICT, OPTIMIZED);',
    '    return 0;',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('hello-42 std=201710 strict=1 optimized=0');
  expect(await countInTerminal(page, /warning:|error:/), await terminalText(page)).toBe(0);
  expect(await squigglyLines(page, 'warning')).toEqual([]);
  expect(await squigglyLines(page, 'error')).toEqual([]);
});

test('c: @nightly 未使用の変数・printf の書式の不一致・未使用の引数は警告として 1 回ずつ出て、実行は success のまま (#710)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    'static int twice(int x, int unused_param) { return 2 * x; }',
    'int main(void) {',
    '    int unused;',
    '    printf("%d\\n", "oops");',
    '    printf("twice=%d\\n", twice(21, 0));',
    '    return 0;',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('twice=42');
  const unusedParameter = /main\.c:2:\d+: warning: unused parameter 'unused_param' \[-Wunused-parameter\]/;
  const unusedVariable = /main\.c:4:9: warning: unused variable 'unused' \[-Wunused-variable\]/;
  const format = /main\.c:5:20: warning: format specifies type 'int' but the argument has type 'char \*' \[-Wformat\]/;
  for (const diagnostic of [unusedParameter, unusedVariable, format]) {
    expect(await countInTerminal(page, diagnostic), `${diagnostic}\n${await terminalText(page)}`).toBe(1);
  }
  expect(await countInTerminal(page, /warning:/), await terminalText(page)).toBe(3);
  await expect
    .poll(() => squigglyLines(page, 'warning'))
    .toEqual([
      'static int twice(int x, int unused_param) { return 2 * x; }',
      '    int unused;',
      '    printf("%d\\n", "oops");',
    ]);
  expect(await squigglyLines(page, 'error')).toEqual([]);
});

test('c: @nightly 宣言の無い関数の呼び出しはエラーになり、その行にマーカーが付いてプログラムを実行しない (#710)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    puts("never");',
    '    return square(3);',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('failure');
  // clang 16 は C99 以降でこの診断を既定でエラーにするので、`-Werror=` を足しても `[-Werror,...]` は付かない
  // (既定のエラーは「警告からの格上げ」ではない)。フラグはコンパイラの既定が変わってもエラーのままにするためのもの。
  // 行の末尾 (`[-Wimplicit-function-declaration]`) はターミナルの幅で折り返すので、前半だけを読む
  const undeclared = /main\.c:4:12: error: call to undeclared function 'square'; ISO C99 and later do not support/;
  await expect.poll(() => countInTerminal(page, undeclared)).toBe(1);
  expect(await terminalText(page)).not.toMatch(/^never$/m);
  await expect.poll(() => squigglyLines(page, 'error')).toEqual(['    return square(3);']);
});
