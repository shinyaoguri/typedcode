import { test, expect, type Page } from '@playwright/test';
import { EditorApp, readAllProofEvents, readProofEvents } from './helpers/app.js';
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
 * - C の実行系 (Wasmer の wasm と clang の webc) は起動では取らず、最初の実行で 1 回だけ取得・初期化し、
 *   続く実行は取り直さない (#617)
 * - Python の `input()` がターミナルに打った行を読み、`window.prompt` に落ちない。案内文は入力の前に出て、
 *   入力待ちの間に停止できる (#649。Pyodide を専用 Worker で動かし、stdin を SharedArrayBuffer で渡す)
 * - C の端末入力 (#707): Enter が LF で届き、バックスペース・空行・日本語・貼り付けを含む行を fgets / scanf が
 *   読み、記録 (terminalInput) と一致する。空の行の Ctrl+D と「入力終了」で EOF を送れ、書きかけの行の Ctrl+D は
 *   行を確定するだけ。選択の無い Ctrl+C で入力待ちを止め、選択があればコピーして止めない。止めた次の実行は成功する
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
  const zipPath = await app.exportAllTabs();
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

test('c: @nightly 起動では C の実行系を取らず、最初の実行で 1 回だけ取得・初期化し、続く実行は取り直さない (#617)', async ({
  page,
}) => {
  const clangFetches: string[] = [];
  const wasmerWasmFetches: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.webc(\?|$)/.test(url)) clangFetches.push(url);
    if (/wasmer_sdk_js_bg\.wasm/.test(url)) wasmerWasmFetches.push(url);
  });

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceCode(
    app,
    '#include <stdio.h>\n\nint main(void) {\n    printf("lazy-c-%d\\n", 6 * 7);\n    return 0;\n}\n'
  );
  await app.waitForSynced();
  const indicator = page.locator('#runtime-state-indicator');
  await expect(indicator).toHaveAttribute('data-runtime-state', 'not-ready');
  expect(clangFetches).toEqual([]);
  expect(wasmerWasmFetches).toEqual([]);

  expect(await runAndWait(page, FIRST_RUN_TIMEOUT_MS), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('lazy-c-42');
  await expect(indicator).toHaveAttribute('data-runtime-state', 'ready');
  await expect(page.locator('#clang-loading-overlay')).toBeHidden();

  expect(await runAndWait(page, 60_000), `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('lazy-c-42');
  expect(clangFetches).toHaveLength(1);
  expect(wasmerWasmFetches).toHaveLength(1);
});

test('python: @nightly hello が Pyodide で実行され、出力と success の result イベントが残り、verify-cli (fast) を通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await expectHelloRoundTrip(app, 'python', 'print("hello-py-" + str(6 * 7))\n', 'hello-py-42');
});

/**
 * `window.prompt` を数える関数に差し替える (#649)。Python の `input()` がブラウザのダイアログに
 * 落ちていないことを確かめる。ダイアログが出たら閉じて数える (prompt 以外の経路も拾う)
 */
async function countPrompts(page: Page): Promise<() => Promise<{ prompts: number; dialogs: number }>> {
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __tcPromptCalls: number };
    w.__tcPromptCalls = 0;
    window.prompt = () => {
      w.__tcPromptCalls++;
      return null;
    };
  });
  return async () => ({
    prompts: await page.evaluate(() => (window as unknown as { __tcPromptCalls: number }).__tcPromptCalls),
    dialogs,
  });
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

/** ターミナルをクリックしてフォーカスし、1 行打って Enter を押す */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(TERMINAL).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

const terminalLines = async (page: Page) => (await terminalText(page)).split('\n').map((l) => l.trim());

test('python: @nightly input() がターミナルに打った行を読み、window.prompt を呼ばない (#649)', async ({ page }) => {
  const prompts = await countPrompts(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'a, b = map(int, input().split())\nprint(a + b)\n');

  const run = await startRun(page);
  // 利用者のコードが走り始めてから打つ (それより前はターミナルが stdin につながっていない)
  await expect.poll(() => terminalText(page), { timeout: FIRST_RUN_TIMEOUT_MS }).toContain('Running Python...');
  await typeLine(page, '3 5');

  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  // 打った行のエコーと、計算した結果がそれぞれの行に出る
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['3 5', '8']));
  expect(await prompts()).toEqual({ prompts: 0, dialogs: 0 });
});

test('python: @nightly input() の案内文が入力を待つ間にターミナルに出て、打った行で続きが動く (#649)', async ({
  page,
}) => {
  const prompts = await countPrompts(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'name = input("名前: ")\nprint("こんにちは " + name)\n');

  const run = await startRun(page);
  // 改行の無い案内文が、入力する前 (実行中) に出る
  await expect
    .poll(() => terminalLines(page), { timeout: FIRST_RUN_TIMEOUT_MS })
    .toEqual(expect.arrayContaining(['名前:']));
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');
  expect(await terminalText(page)).not.toContain('こんにちは');

  await typeLine(page, 'Taro');
  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['名前: Taro', 'こんにちは Taro']));
  expect(await prompts()).toEqual({ prompts: 0, dialogs: 0 });
});

test('python: @nightly 入力を待つ間に停止すると aborted で終わり、続けて別のコードを実行できる (#649)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'value = input("wait: ")\nprint("never")\n');

  const stopped = await startRun(page);
  await expect
    .poll(() => terminalLines(page), { timeout: FIRST_RUN_TIMEOUT_MS })
    .toEqual(expect.arrayContaining(['wait:']));
  await page.locator('#stop-code-btn').click();
  expect(await waitOutcome(page, stopped, 15_000)).toBe('aborted');

  // 停止で Worker ごと捨てるので、次の実行は Pyodide を読み込み直してから走る
  await replaceCode(app, 'print("after-stop-" + str(6 * 7))\n');
  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('after-stop-42');
  expect(await terminalText(page)).not.toContain('never');
});

// ---- C の端末入力 (#707) ----

/** C のプログラムが stdin を読める (ターミナルが stdin につながった) まで待つ。状態契約 `data-stdin-state` で読む */
async function waitStdinOpen(page: Page): Promise<void> {
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open', { timeout: FIRST_RUN_TIMEOUT_MS });
}

/**
 * ターミナルの入力 textarea に貼り付けを届ける (headless の Chromium は実ペーストの paste イベントを出さないので、
 * terminal-paste.spec.ts と同じく clipboardData を持つ ClipboardEvent を dispatch する)
 */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  const textarea = page.locator(`${TERMINAL} .xterm-helper-textarea`);
  await textarea.focus();
  await textarea.evaluate((el, t) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

/** proof の terminalInput イベントが記録した行 (description の「ラベル: 」の後ろ) */
function terminalInputLines(events: { type: string; description?: unknown }[]): string[] {
  return events
    .filter((e) => e.type === 'terminalInput')
    .map((e) => String(e.description ?? '').replace(/^[^:]*: /, ''));
}

/** C のコードを行の配列で置く */
async function replaceCLines(app: EditorApp, lines: string[]): Promise<void> {
  await replaceCode(app, `${lines.join('\n')}\n`);
}

test('c: @nightly fgets と scanf が Enter・バックスペース・空行・日本語・貼り付けを含む行を読み、記録と一致する (#707)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceCLines(app, [
    '#include <stdio.h>',
    '#include <string.h>',
    'int main(void) {',
    '    char s[64];',
    '    for (int i = 0; i < 3; i++) {',
    '        if (!fgets(s, sizeof s, stdin)) return 2;',
    '        size_t n = strlen(s);',
    '        int nl = n > 0 && s[n - 1] == 10;',
    '        if (nl) s[n - 1] = 0;',
    '        printf("line%d=[%s] len=%zu nl=%d\\n", i, s, n, nl);',
    '    }',
    '    int a, b;',
    '    if (scanf("%d %d", &a, &b) != 2) return 3;',
    '    printf("sum=%d\\n", a + b);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await waitStdinOpen(page);
  await page.locator(TERMINAL).click();
  // 12 → Backspace → 3 → Enter は "13\n" (Enter は LF。#707 の再現)
  await page.keyboard.type('12');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  // 打った行はエコーされ (編集後の "13")、プログラムの出力と並ぶ
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['13', 'line0=[13] len=3 nl=1']));
  // 空行
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['line1=[] len=1 nl=1']));
  // 日本語のバックスペースは 1 文字 (UTF-8 の 3 バイト) を消す
  await page.keyboard.type('日本語');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['line2=[日本] len=7 nl=1']));
  // 貼り付けの塊 (改行込み) を scanf が読む
  await pasteIntoTerminal(page, '3 5\r');

  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  // 見えている行 (ターミナルの高さの分) に、後半のエコーと結果が並ぶ
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['日本', '3 5', 'sum=8']));

  // 記録 (terminalInput) はプログラムが受け取った行と同じ。空行は記録しない (#648)
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  expect(terminalInputLines(await readProofEvents(zipPath))).toEqual(['13', '日本', '3 5']);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('c: @nightly Enter は LF で届き、空の行の Ctrl+D で getchar が EOF を返して feof が真になる (#707)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceCLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    int a = getchar();',
    '    int b = getchar();',
    '    printf("a=%d b=%d eof=%d\\n", a, b, feof(stdin) != 0);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await waitStdinOpen(page);
  await page.locator(TERMINAL).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+D');

  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['a=10 b=-1 eof=1']));
});

test('c: @nightly 書きかけの行の Ctrl+D は行を確定するだけで、「入力終了」が残りの行を確定してから EOF を送る (#707)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceCLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    int c, chars = 0, lines = 0;',
    '    while ((c = getchar()) != EOF) {',
    '        chars++;',
    '        if (c == 10) printf("got-line %d\\n", ++lines);',
    '    }',
    '    printf("chars=%d lines=%d\\n", chars, lines);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await waitStdinOpen(page);
  await page.locator(TERMINAL).click();
  await page.keyboard.type('ab');
  await page.keyboard.press('Control+D');
  // 書きかけの "ab" は LF 付きで確定し、stdin は閉じない (ループは続く)
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['got-line 1']));
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open');
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');

  await page.keyboard.type('cd');
  await page.locator('#stdin-eof-btn').click();

  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['chars=6 lines=2']));
});

test('cpp: @nightly C++ のプログラムも C と同じ行の入力を読み、空の行の Ctrl+D で EOF になる (#707)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('cpp');
  // stdin の経路 (CExecutor の pipe) を見る。<iostream> はこの環境のコンパイルが重いので <cstdio> にする
  await replaceCLines(app, [
    '#include <cstdio>',
    '#include <cstring>',
    'int main() {',
    '    char s[32];',
    '    if (!std::fgets(s, sizeof s, stdin)) return 2;',
    '    s[std::strcspn(s, "\\n")] = 0;',
    '    int n = 0, sum = 0;',
    '    while (std::scanf("%d", &n) == 1) sum += n;',
    '    std::printf("cpp=[%s] sum=%d eof=%d\\n", s, sum, std::feof(stdin) != 0);',
    '    return 0;',
    '}',
  ]);

  const run = await startRun(page);
  await waitStdinOpen(page);
  await page.locator(TERMINAL).click();
  await page.keyboard.type('ab');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.keyboard.type('3 4');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+D');

  const outcome = await waitOutcome(page, run, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['cpp=[a] sum=7 eof=1']));
});

test('c: @nightly 選択があれば Ctrl+C はコピーして実行を続け、選択が無ければ入力待ちを止め、次の実行が成功する (#707)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await replaceCLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    char s[16];',
    '    printf("wait-input\\n");',
    '    if (fgets(s, sizeof s, stdin)) printf("never\\n");',
    '    return 0;',
    '}',
  ]);

  const stopped = await startRun(page);
  await waitStdinOpen(page);
  await expect.poll(() => terminalLines(page)).toEqual(expect.arrayContaining(['wait-input']));

  // ターミナルの 1 行目 (実行の案内) をドラッグで選んで Ctrl+C: コピーになり、止めない
  await page.evaluate(() => navigator.clipboard.writeText('clipboard-before'));
  const firstRow = page.locator(`${TERMINAL} .xterm-rows > div`).first();
  const box = await firstRow.boundingBox();
  if (!box) throw new Error('terminal row is not visible');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Control+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Compiling');
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');

  // 選択はコピーで外れるので、次の Ctrl+C は入力待ちを止める
  await page.keyboard.press('Control+C');
  expect(await waitOutcome(page, stopped, 15_000)).toBe('aborted');

  await replaceCLines(app, [
    '#include <stdio.h>',
    'int main(void) {',
    '    printf("after-stop-%d\\n", 6 * 7);',
    '    return 0;',
    '}',
  ]);
  const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('after-stop-42');
  expect(await terminalText(page)).not.toContain('never');
});
