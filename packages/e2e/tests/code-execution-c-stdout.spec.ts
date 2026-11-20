import { test, expect, type Page } from '@playwright/test';
import { EditorApp, listZipEntries, readAllProofEvents, readZipEntryText } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * C / C++ の stdout の支援コードを、利用者のソースとは別の翻訳単位にした nightly 検査 (#709)。
 *
 * 以前は利用者のソースの前に `#include <stdio.h>`・constructor・`#line 1` を置いていたので、`stdio.h` を
 * 書き忘れたコードが通り、利用者の翻訳単位に `FILE` / `EOF` などの宣言が入っていた。いまは支援コード
 * (`__typedcode_stdout.c` / `.cpp`) を 2 つ目の入力としてコンパイル・リンクし、利用者のソースは何も変えない。
 * ここで確かめること:
 * - `stdio.h` を書かない `printf` は Clang 16 (C の既定の gnu17) でエラーとして診断され、その行にマーカーが付く。
 *   書けば成功し、その実行を含む export が verify-cli (fast) を通る
 * - 利用者の翻訳単位に `stdio.h` 由来の宣言が無い (`FILE` を自分で定義でき、`EOF` は未定義、`printf` を
 *   別の型で宣言しても衝突しない。include しない `FILE` は未知の型)
 * - stdout は非バッファ: 改行の無いプロンプトが入力を待つ間に出る。`__LINE__` / `__FILE__` は利用者のソースのまま
 * - 利用者が自分で呼ぶ `setvbuf` は、バッファを渡せば支援コードより後に効き (`fflush` で出る)、NULL なら非バッファのまま
 * - C++ の `<cstdio>` でも同じ支援コードが効き、`cstdio` を書かない `printf` は従来どおり C++ のエラー
 *
 * 実行系を外部の配信物から取るので `@nightly` (code-execution-c-python.spec.ts と同じ扱い)。実行の状態は
 * 状態契約 (`data-exec-state` / `data-exec-run` / `data-exec-outcome` / `data-stdin-state`) で読み、
 * ターミナルからは利用者のコードが出した文字列と clang の英語のメッセージだけを読む。
 */

const TERMINAL = '#xterm-container';

/** 実行系の取得・初期化を含む 1 回目の実行の終わりを待つ上限 (CDN の遅い夜を見込む) */
const FIRST_RUN_TIMEOUT_MS = 240_000;

test.describe.configure({ timeout: 360_000 });

async function replaceLines(app: EditorApp, lines: string[]): Promise<void> {
  await app.focusEditor();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await app.injectCodeBlock(`${lines.join('\n')}\n`);
}

async function execState(page: Page) {
  return page.locator(TERMINAL).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

/** Run を押し、その run が始まった (data-exec-run が進んだ) ところで run の番号を返す */
async function startRun(page: Page): Promise<number> {
  const run = (await execState(page)).run + 1;
  await page.locator('#run-code-btn').click();
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', String(run), { timeout: 15_000 });
  return run;
}

/** run が終わる (data-exec-run が run で data-exec-state=idle) まで待って outcome を返す */
async function waitOutcome(page: Page, run: number, timeout: number): Promise<string | null> {
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

async function runAndWait(page: Page, timeout = FIRST_RUN_TIMEOUT_MS): Promise<string | null> {
  return waitOutcome(page, await startRun(page), timeout);
}

/** ターミナルの見えている行の文字列 (xterm の DOM レンダラの行) */
async function terminalText(page: Page): Promise<string> {
  return page
    .locator(`${TERMINAL} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'));
}

const terminalLines = async (page: Page) => (await terminalText(page)).split('\n').map((l) => l.trim());

/** ターミナルをクリックしてフォーカスし、1 行打って Enter を押す */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(TERMINAL).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** 実行のマーカー (squiggly-error) が付いた行の文字列。C / C++ には Monaco 自身の診断が無いので実行のマーカーだけ */
async function errorMarkerLines(page: Page): Promise<string[]> {
  const squigglies = await page
    .locator('.monaco-editor .squiggly-error')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  const viewLines = await page
    .locator('.monaco-editor .view-lines .view-line')
    .evaluateAll((els) =>
      els.map((l) => ({ top: l.getBoundingClientRect().top, text: (l.textContent ?? '').replace(/\u00a0/g, ' ') }))
    );
  return squigglies.map((top) => viewLines.find((l) => Math.abs(l.top - top) < 4)?.text ?? `(no line at ${top})`);
}

test('c: @nightly stdio.h を書かない printf はその行でエラーになり、書けば成功して export が verify-cli (fast) を通る (#709)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, ['int main(void) {', '    printf("missing-include\\n");', '    return 0;', '}']);

  expect(await runAndWait(page), `terminal:\n${await terminalText(page)}`).toBe('failure');
  // C99 以降は暗黙の関数宣言を許さない。Clang 16 は C の既定 (gnu17) でこれをエラーにする
  await expect
    .poll(() => terminalText(page))
    .toMatch(/main\.c:2:5: error: call to undeclared library function 'printf'/);
  await expect.poll(() => errorMarkerLines(page)).toEqual(['    printf("missing-include\\n");']);
  expect(await terminalLines(page)).not.toContain('missing-include');

  await replaceLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    printf("with-include-%d\\n", 6 * 7);',
    '    return 0;',
    '}',
  ]);
  expect(await runAndWait(page, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['with-include-42']));

  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const outcomes = [...(await readAllProofEvents(zipPath)).values()]
    .flat()
    .filter((e) => e.type === 'codeExecution' && (e.data as { phase?: string } | null)?.phase === 'result')
    .map((e) => (e.data as { outcome?: string }).outcome);
  expect(outcomes).toEqual(['failure', 'success']);
  // export されるソースは利用者が書いたものだけ (支援コードは入らない)
  const sources = await Promise.all(
    (await listZipEntries(zipPath)).filter((n) => n.endsWith('.c')).map((n) => readZipEntryText(zipPath, n))
  );
  expect(sources).toHaveLength(1);
  expect(sources[0]).toContain('with-include-%d');
  expect(sources[0]).not.toContain('setvbuf');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('c: @nightly 利用者の翻訳単位に stdio.h 由来の宣言が入らない (FILE を自分で定義でき、EOF は未定義、printf を別の型で宣言できる。#709)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  // stdio.h が前置されていれば、FILE の再定義・EOF・static の printf のどれかでコンパイルが落ちる
  await replaceLines(app, [
    'typedef int FILE;',
    '#ifdef EOF',
    '#error EOF is defined without including stdio.h',
    '#endif',
    'static int printf(int x) { return x - 7; }',
    'int main(void) {',
    '    FILE seven = 7;',
    '    return printf(seven);',
    '}',
  ]);
  expect(await runAndWait(page), `terminal:\n${await terminalText(page)}`).toBe('success');

  // include しない FILE は未知の型
  await replaceLines(app, ['int main(void) {', '    return (int)sizeof(FILE);', '}']);
  expect(await runAndWait(page, 60_000), `terminal:\n${await terminalText(page)}`).toBe('failure');
  await expect.poll(() => terminalText(page)).toMatch(/main\.c:2:24: error: use of undeclared identifier 'FILE'/);
});

test('c: @nightly stdout は非バッファで、改行の無いプロンプトが入力の前に出て、__LINE__ / __FILE__ は利用者のソースのまま (#709 / #489)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    '#include <string.h>',
    'int main(void) {',
    '    char s[32];',
    '    printf("name? ");',
    '    if (!fgets(s, sizeof s, stdin)) return 2;',
    '    s[strcspn(s, "\\n")] = 0;',
    '    printf("hello %s line=%d file=%s\\n", s, __LINE__, __FILE__);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open', { timeout: FIRST_RUN_TIMEOUT_MS });
  // 入力を待つ間 (実行中) に、改行の無い案内文が出ている
  await expect.poll(() => terminalLines(page), { timeout: 30_000 }).toEqual(expect.arrayContaining(['name?']));
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');
  expect(await terminalText(page)).not.toContain('hello');

  await typeLine(page, 'Taro');
  expect(await waitOutcome(page, run, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect
    .poll(() => terminalLines(page))
    .toEqual(expect.arrayContaining(['name? Taro', 'hello Taro line=8 file=/workspace/main.c']));
});

/**
 * 利用者が自分で呼ぶ `setvbuf` の挙動 (#709 で明記したもの)。wasi-libc (musl) の `setvbuf` は、バッファを
 * 渡されたときだけバッファの大きさを変える。支援コードが constructor で非バッファ (大きさ 0) にした後なので:
 * - `setvbuf(stdout, buf, _IOFBF, sizeof buf)` (バッファを渡す) はフルバッファになり、`fflush` まで出ない
 * - `setvbuf(stdout, NULL, _IOFBF, n)` (NULL) は非バッファのまま (ネイティブの pipe の既定のフルバッファとは違う。
 *   支援コードを前置していた以前と同じ)
 */
test('c: @nightly 利用者の setvbuf はバッファを渡せば支援コードより後に効いて fflush で出て、NULL なら非バッファのまま (#709)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    char s[32];',
    '    setvbuf(stdout, NULL, _IOFBF, BUFSIZ);',
    '    printf("nullbuf-visible ");',
    '    if (!fgets(s, sizeof s, stdin)) return 2;',
    '    return 0;',
    '}',
  ]);
  const nullRun = await startRun(page);
  await expect.poll(() => terminalText(page), { timeout: FIRST_RUN_TIMEOUT_MS }).toMatch(/^nullbuf-visible\s*$/m);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');
  await typeLine(page, 'z');
  expect(await waitOutcome(page, nullRun, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');

  await replaceLines(app, [
    '#include <stdio.h>',
    'static char buf[BUFSIZ];',
    'int main(void) {',
    '    char s[32];',
    '    setvbuf(stdout, buf, _IOFBF, sizeof buf);',
    '    printf("held-a ");',
    '    fprintf(stderr, "ready-a\\n");',
    '    if (!fgets(s, sizeof s, stdin)) return 2;',
    '    printf("flushed-b ");',
    '    fflush(stdout);',
    '    if (!fgets(s, sizeof s, stdin)) return 3;',
    '    printf("end\\n");',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  // stderr (非バッファ) の印が出た時点で、その前に書いた stdout はまだバッファの中
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain('ready-a');
  await page.waitForTimeout(1_000);
  expect(await terminalText(page)).not.toContain('held-a');

  await typeLine(page, 'x');
  // fflush でバッファの中身ごと出る (入力を待つ間、実行中に)
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain('held-a flushed-b');
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');

  await typeLine(page, 'y');
  expect(await waitOutcome(page, run, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('end');
});

test('cpp: @nightly <cstdio> でも改行の無いプロンプトが入力の前に出て、cstdio を書かない printf はエラーになる (#709)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('cpp');
  // C++ の標準ライブラリの多くは #573 で使えないので、<cstdio> だけを使う
  await replaceLines(app, [
    '#include <cstdio>',
    'int main() {',
    '    char s[32];',
    '    std::printf("cpp-name? ");',
    '    if (!std::fgets(s, sizeof s, stdin)) return 2;',
    '    std::printf("cpp-got %s", s);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open', { timeout: FIRST_RUN_TIMEOUT_MS });
  await expect.poll(() => terminalLines(page), { timeout: 30_000 }).toEqual(expect.arrayContaining(['cpp-name?']));
  await typeLine(page, 'Jiro');
  expect(await waitOutcome(page, run, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['cpp-got Jiro']));

  await replaceLines(app, ['int main() {', '    printf("cpp-missing\\n");', '    return 0;', '}']);
  expect(await runAndWait(page, 60_000), `terminal:\n${await terminalText(page)}`).toBe('failure');
  await expect.poll(() => terminalText(page)).toMatch(/main\.cpp:2:5: error: use of undeclared identifier 'printf'/);
  await expect.poll(() => errorMarkerLines(page)).toEqual(['    printf("cpp-missing\\n");']);
});
