import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * C / C++ の `clock()` の nightly 検査 (#714)。
 *
 * clang の webc (`clang-0.1.1.webc`) のドライバは `-D_WASI_EMULATED_PROCESS_CLOCKS` を自分で足して
 * `<time.h>` に `clock()` を宣言させるが、リンクには実体のある `libwasi-emulated-process-clocks.a` を
 * 足さない。CExecutor がリンクの引数 `-lwasi-emulated-process-clocks` を渡すので、`clock()` がリンクできる。
 *
 * その `clock()` は wasi-libc のエミュレーションで、プログラムの開始からの CLOCK_MONOTONIC の経過
 * (= 実時間) を返す。CPU 時間ではない (Wasmer のランタイムは CPU 時間の時計
 * `CLOCK_PROCESS_CPUTIME_ID` も実時間で返す)。ネイティブの `clock()` と同じ意味だと誤解させないよう、
 * 眠っている間も進むことをここで固定する (将来 CPU 時間を返すランタイムに替わったら、この検査が知らせる)。
 *
 * 実行系を外部の配信物から取るので `@nightly` (code-execution-c-python.spec.ts と同じ扱い)。
 * 実行の終わりは状態契約 (`data-exec-state` / `data-exec-run` / `data-exec-outcome`) で読み、
 * ターミナルからは利用者のコードが出した文字列だけを読む。
 */

const TERMINAL = '#xterm-container';

/** 実行系の取得・初期化を含む 1 回目の実行の終わりを待つ上限 (CDN の遅い夜を見込む) */
const FIRST_RUN_TIMEOUT_MS = 240_000;

test.describe.configure({ timeout: 360_000 });

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

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(`${TERMINAL} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/ /g, ' ')).join('\n'));
}

/** code を実行して success で終わることを確かめ、出力の `marker <数値>...` の行を返す */
async function runAndReadLine(app: EditorApp, language: 'c' | 'cpp', code: string, marker: RegExp) {
  const { page } = app;
  await app.setLanguage(language);
  await replaceCode(app, code);
  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toMatch(marker);
  return (await terminalText(page)).match(marker) as RegExpMatchArray;
}

test('c: @nightly clock() がリンクされ、clock_t / CLOCKS_PER_SEC の値と失敗値でない戻り値を返し、計算の間に進む (#714)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const code = [
    '#include <stdio.h>',
    '#include <time.h>',
    '',
    'int main(void) {',
    '    clock_t start = clock();',
    '    volatile unsigned long s = 0;',
    '    for (unsigned long i = 0; i < 100000000UL; i++) s += i;',
    '    clock_t end = clock();',
    '    printf("clock-c cps=%lld size=%d failed=%d advanced=%d\\n", (long long)CLOCKS_PER_SEC,',
    '           (int)sizeof(clock_t), start == (clock_t)-1 || end == (clock_t)-1, end > start);',
    '    return 0;',
    '}',
    '',
  ].join('\n');
  const m = await runAndReadLine(app, 'c', code, /clock-c cps=(\d+) size=(\d+) failed=(\d) advanced=(\d)/);
  // wasi-libc の CLOCKS_PER_SEC はナノ秒 (1e9) で、clock_t は 64 ビット
  expect(m.slice(1)).toEqual(['1000000000', '8', '0', '1']);
});

test('c: @nightly clock() はこの実行環境では実時間で進み、眠っている間も進む (CPU 時間ではない。#714)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  // 300ms 眠る。ネイティブの clock() (CPU 時間) ならほぼ進まないが、ここでは実時間なので 300ms 前後進む
  const code = [
    '#include <stdio.h>',
    '#include <time.h>',
    '',
    'int main(void) {',
    '    struct timespec nap = {0, 300000000L};',
    '    clock_t start = clock();',
    '    nanosleep(&nap, NULL);',
    '    clock_t end = clock();',
    '    printf("clock-sleep ms=%lld\\n", (long long)((end - start) * 1000 / CLOCKS_PER_SEC));',
    '    return 0;',
    '}',
    '',
  ].join('\n');
  const m = await runAndReadLine(app, 'c', code, /clock-sleep ms=(\d+)/);
  expect(Number(m[1])).toBeGreaterThanOrEqual(250);
});

test('cpp: @nightly std::clock() もリンクされて実行できる (#714)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  // C++ の標準ライブラリの多くは #573 で使えないので、<cstdio> と <ctime> だけを使う
  const code = [
    '#include <cstdio>',
    '#include <ctime>',
    '',
    'int main() {',
    '    std::clock_t c = std::clock();',
    '    std::printf("clock-cpp failed=%d\\n", c == (std::clock_t)-1);',
    '    return 0;',
    '}',
    '',
  ].join('\n');
  const m = await runAndReadLine(app, 'cpp', code, /clock-cpp failed=(\d)/);
  expect(m[1]).toBe('0');
});
