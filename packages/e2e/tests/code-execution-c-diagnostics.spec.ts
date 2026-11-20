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
 * 実物の clang のコンパイラ診断がターミナルとエディタのマーカーに届くことの nightly 検査 (#708)。
 *
 * unit (`CExecutor.test.ts` の `compiler diagnostics (#708)`・`CodeExecutionController.compilerDiagnostics.test.ts`) は
 * 偽の SDK で経路を固定している。ここでは本物の clang 16 (Wasmer) が出す stderr の形 (`/workspace/main.c:3:24: warning:`)
 * と、コンパイルを `spawn({ stderr: 'capture' })` + `wait()` で起こしたときに stderr が実際に取れることを確かめる。
 * - 警告だけのコンパイルは実行まで進んで success のまま、警告がターミナルに 1 回出て、元のソースの行に warning のマーカーが付く。
 *   次の実行で古いマーカーは消える
 * - ターミナルは見えている行 (xterm の DOM の行) だけを読むので、パネルを広げ (`enlargeTerminal`)、診断の行数も
 *   画面に収まる量にする。run の先頭が流れていれば `countInTerminal` が数えずに落ちる
 * - `fatal error` (見つからない #include) が元のソースの行に error のマーカーとして付く
 * - 失敗したコンパイルの診断 (error と warning) は 1 回ずつだけ出て、それぞれの行にマーカーが付く
 * - C++ (main.cpp) でも同じ
 *
 * clang の webc を外部 (assets.typedcode.dev) から取るので PR ゲートには載せず `@nightly` にする
 * (playwright.config.ts の grepInvert。NIGHTLY=1 で含まれる)。本番ビルドでの同じ経路は production-build.spec.ts の
 * `@nightly` が見る。C++ は `<iostream>` だとコンパイルが終わらない (#573) ので `<cstdio>` で書く。
 */

test.describe.configure({ timeout: 360_000 });

/** #708 の再現の例: `if (0)` の中の誤った printf は実行されず、警告だけが出る */
const WARNING_ONLY_C = [
  '#include <stdio.h>',
  'int main(void) {',
  '    if (0) printf("%d", "oops");',
  '    puts("ran despite warning");',
  '}',
];

test('c: @nightly 警告だけのコンパイルは success のまま、警告がターミナルに 1 回出て元の行に warning のマーカーが付き、次の実行で消える (#708)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, WARNING_ONLY_C);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  // 診断と出力の全体を数えられるよう、run の先頭が流れない高さに広げる
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('ran despite warning');
  // clang の行・列が利用者のコードの位置を指す (preamble の分ずれない = #489 の `#line 1`)
  const warning = /main\.c:3:25: warning: format specifies type 'int'/;
  expect(await countInTerminal(page, warning), await terminalText(page)).toBe(1);
  await expect.poll(() => squigglyLines(page, 'warning')).toEqual(['    if (0) printf("%d", "oops");']);
  expect(await squigglyLines(page, 'error')).toEqual([]);

  // 警告の無いコードの次の実行で、前の run のマーカーは消える
  await replaceLines(app, ['#include <stdio.h>', 'int main(void) {', '    puts("clean run");', '}']);
  expect(await runAndWait(page, 60_000)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('clean run');
  expect(await countInTerminal(page, /warning:/)).toBe(0);
  await expect.poll(() => squigglyLines(page, 'warning')).toEqual([]);
});

test('c: @nightly fatal error (見つからない #include) が元の行に error のマーカーとして付き、ターミナルに 1 回出る (#708)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    '#include "student.h"',
    'int main(void) {',
    '    puts("never");',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  // 診断と出力の全体を数えられるよう、run の先頭が流れない高さに広げる
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('failure');
  const fatal = /main\.c:2:10: fatal error: 'student\.h' file not found/;
  await expect.poll(() => countInTerminal(page, fatal)).toBe(1);
  expect(await terminalText(page)).not.toContain('never');
  await expect.poll(() => squigglyLines(page, 'error')).toEqual(['#include "student.h"']);
});

test('c: @nightly 失敗したコンパイルの error と warning は 1 回ずつだけ出て、それぞれの行にマーカーが付く (#708)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    1 + 2;',
    '    return undefined_var;',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  // 診断と出力の全体を数えられるよう、run の先頭が流れない高さに広げる
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('failure');
  await expect.poll(() => countInTerminal(page, /main\.c:4:12: error: use of undeclared identifier/)).toBe(1);
  expect(await countInTerminal(page, /main\.c:3:\d+: warning: expression result unused/), await terminalText(page)).toBe(1);
  await expect.poll(() => squigglyLines(page, 'error')).toEqual(['    return undefined_var;']);
  expect(await squigglyLines(page, 'warning')).toEqual(['    1 + 2;']);
});

test('cpp: @nightly C++ でも警告だけなら success のまま main.cpp の行に warning のマーカーが付き、次の fatal error で error のマーカーに置き換わる (#708)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('cpp');
  await replaceLines(app, [
    '#include <cstdio>',
    'int main() {',
    '    if (0) std::printf("%d", "oops");',
    '    std::puts("cpp ran despite warning");',
    '}',
  ]);

  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  // 診断と出力の全体を数えられるよう、run の先頭が流れない高さに広げる
  await enlargeTerminal(page);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('cpp ran despite warning');
  expect(
    await countInTerminal(page, /main\.cpp:3:\d+: warning: format specifies type 'int'/),
    await terminalText(page)
  ).toBe(1);
  await expect.poll(() => squigglyLines(page, 'warning')).toEqual(['    if (0) std::printf("%d", "oops");']);

  await replaceLines(app, ['#include <cstdio>', '#include "student.hpp"', 'int main() {', '}']);
  expect(await runAndWait(page, 60_000)).toBe('failure');
  await expect
    .poll(() => countInTerminal(page, /main\.cpp:2:10: fatal error: 'student\.hpp' file not found/))
    .toBe(1);
  await expect.poll(() => squigglyLines(page, 'error')).toEqual(['#include "student.hpp"']);
  expect(await squigglyLines(page, 'warning')).toEqual([]);
});
