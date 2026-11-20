import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import {
  FIRST_RUN_TIMEOUT_MS,
  replaceCode,
  replaceLines,
  runAndWait,
  startRun,
  terminalText,
  waitOutcome,
} from './helpers/cExecution.js';

/**
 * 実物の clang のコンパイル中に停止したときの nightly 検査 (#711)。
 *
 * unit (`CExecutor.test.ts` の停止系) は偽の SDK の各段階を deferred で止めて、段階の境目で後続へ進まないことを固定している。
 * ここでは本物の clang 16 (Wasmer) で、コンパイラを `spawn` + `wait` で起こして `Process.kill()` で止める経路を通す:
 * - コンパイル中に停止すると aborted で終わり、利用者のプログラムは起動されない (出力も出ない)
 * - 停止直後の再実行が成功し、停止した run の出力・結果が混ざらない
 *
 * 画面の状態契約 (`data-exec-*`) とターミナルだけでは足りない所がある: controller は停止した run の出力を捨てるので、
 * executor が利用者のプログラムを起動したかはターミナルからは見えない (#711 の再現は executor の結果でしか見えなかった)。
 * そこで dev サーバの同じモジュール (`/src/executors/c/CExecutor.ts`) を page から import して executor の singleton を包み、
 * run ごとの executor の結果・出力と、保持した Process (コンパイラか利用者プログラムか) を `window.__tcCExecTrace` に記録する
 * (`installExecutorTrace`)。包むのは `runWithOptions` と `holdProcess` (どちらも CExecutor の内部の名前。変えたらここも直す)。
 *
 * コンパイル中に確実に止めるため、コンパイルに時間のかかるコード (マクロで 4^7 個の関数を生む。手元で約 40 秒) を使い、
 * 固定の sleep ではなく「executor がコンパイラの Process を保持した」と「Wasmer の worker が clang で塞がっている」を待ってから止める。
 *
 * clang の webc を外部 (assets.typedcode.dev) から取るので PR ゲートには載せず `@nightly` にする
 * (playwright.config.ts の grepInvert。NIGHTLY=1 で含まれる)。C++ は `<iostream>` だとコンパイルが終わらない (#573) ので、
 * 重いコンパイルは C と同じマクロで作る (#573 に依存しない)。
 */

test.describe.configure({ timeout: 360_000 });

/** 実行されたら出る印。コンパイル中に止めた run の後に、これがどこにも出てはいけない (#711 の再現の文字列) */
const EXECUTED_MARK = 'EXECUTED_AFTER_COMPILE_ABORT';

/**
 * コンパイルに時間のかかるコード: F が 1 個の関数、L1..L7 がそれぞれ 4 倍にして 4^7 = 16384 個の関数を -O2 で
 * コンパイルさせる (手元の clang 16 / Wasmer で約 40 秒。4^6 で約 10 秒)。外部リンケージなので最適化で消えない
 */
function slowToCompile(lang: 'c' | 'cpp'): string {
  const lines = [lang === 'c' ? '#include <stdio.h>' : '#include <cstdio>'];
  lines.push('#define F(n) int g##n(int x){int s=0;for(int i=0;i<x;i++){s+=(i*n)^(s>>3);if(s%7==n%7)s-=x;}return s;}');
  let prev = 'F';
  for (let level = 1; level <= 7; level++) {
    lines.push(`#define L${level}(n) ${prev}(n##0) ${prev}(n##1) ${prev}(n##2) ${prev}(n##3)`);
    prev = `L${level}`;
  }
  lines.push(`${prev}(1)`);
  lines.push(`int main() { ${lang === 'c' ? 'puts' : 'std::puts'}("${EXECUTED_MARK}"); return 0; }`);
  return `${lines.join('\n')}\n`;
}

interface TracedRun {
  stdout: string;
  result: { outcome: string; exitCode: number } | { error: string } | null;
  /** この run が保持した Process (コンパイラ = false / 利用者プログラム = true) の順 */
  held: boolean[];
}

/**
 * executor の singleton を包んで、run ごとの結果・executor が受け取った stdout・保持した Process を記録する。
 * dev サーバでは controller と同じ URL のモジュールを import するので、同じ singleton が返る
 * (返らなければ、run の後に trace が空のままになり、下の検査が落ちる)
 */
async function installExecutorTrace(page: Page, lang: 'c' | 'cpp'): Promise<void> {
  await page.evaluate(async (language) => {
    type Callbacks = { onStdout: (t: string) => void } & Record<string, unknown>;
    type Result = { success: boolean; exitCode: number; outcome?: string };
    type Executor = {
      runWithOptions: (code: string, cb: Callbacks, ...rest: unknown[]) => Promise<Result>;
      holdProcess: (run: unknown, process: unknown, isProgram: boolean) => boolean;
    };
    const mod =
      language === 'c'
        ? await import(/* @vite-ignore */ '/src/executors/c/CExecutor.ts')
        : await import(/* @vite-ignore */ '/src/executors/cpp/CppExecutor.ts');
    const executor = (language === 'c' ? mod.getCExecutor() : mod.getCppExecutor()) as Executor;
    if (typeof executor.runWithOptions !== 'function' || typeof executor.holdProcess !== 'function') {
      throw new Error('CExecutor の runWithOptions / holdProcess が見つからない (名前が変わったら spec を直す)');
    }
    const runs: TracedRun[] = [];
    (window as unknown as { __tcCExecTrace: TracedRun[] }).__tcCExecTrace = runs;
    let current: TracedRun | null = null;
    const runWithOptions = executor.runWithOptions.bind(executor);
    executor.runWithOptions = async (code, cb, ...rest) => {
      const rec: TracedRun = { stdout: '', result: null, held: [] };
      runs.push(rec);
      current = rec;
      const traced: Callbacks = {
        ...cb,
        onStdout: (text: string) => {
          rec.stdout += text;
          cb.onStdout(text);
        },
      };
      try {
        const result = await runWithOptions(code, traced, ...rest);
        rec.result = { outcome: result.outcome ?? (result.success ? 'success' : 'failure'), exitCode: result.exitCode };
        return result;
      } catch (error) {
        rec.result = { error: String(error) };
        throw error;
      }
    };
    const holdProcess = executor.holdProcess.bind(executor);
    executor.holdProcess = (run, process, isProgram) => {
      current?.held.push(isProgram);
      return holdProcess(run, process, isProgram);
    };
  }, lang);
}

async function trace(page: Page): Promise<TracedRun[]> {
  return page.evaluate(() => (window as unknown as { __tcCExecTrace: TracedRun[] }).__tcCExecTrace);
}

/**
 * Wasmer の worker のうち、1.5 秒以内に応答しない (clang などの wasm が同期的に走り続けて塞がっている) ものの数。
 * 何も走っていなければ 0 (手元の実測で、待機中の worker は応答する)
 */
async function busyWasmerWorkers(page: Page): Promise<number> {
  const workers = page.workers().filter((w) => /@wasmer\/sdk|wasmer/i.test(w.url()));
  const answers = await Promise.all(
    workers.map((w) =>
      Promise.race([
        w.evaluate(() => 'idle').catch(() => 'gone'),
        new Promise<string>((resolve) => setTimeout(() => resolve('busy'), 1_500)),
      ])
    )
  );
  return answers.filter((a) => a === 'busy').length;
}

/** 重いコードの run を始め、コンパイラを保持して clang が worker を塞いでいる (= コンパイル中) ところで止める */
async function stopDuringCompile(page: Page): Promise<number> {
  const run = await startRun(page);
  await expect
    .poll(async () => (await trace(page)).at(-1)?.held ?? [], { timeout: FIRST_RUN_TIMEOUT_MS })
    .toEqual([false]);
  await expect.poll(() => busyWasmerWorkers(page), { timeout: 15_000 }).toBeGreaterThan(0);
  // まだコンパイル中 (executor の run が終わっていない)
  expect((await trace(page)).at(-1)?.result).toBeNull();
  await page.locator('#stop-code-btn').click();
  return run;
}

for (const lang of ['c', 'cpp'] as const) {
  test(`${lang}: @nightly コンパイル中に停止すると利用者のプログラムを起動せずに aborted で終わり、直後の再実行が古い run と混ざらずに成功する (#711)`, async ({
    page,
  }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.setLanguage(lang);
    await installExecutorTrace(page, lang);
    await replaceCode(app, slowToCompile(lang));

    const stopped = await stopDuringCompile(page);
    expect(await waitOutcome(page, stopped, 15_000)).toBe('aborted');
    // executor の run も aborted で終わる (コンパイラの wait が kill で返る)。利用者のプログラムは保持 (= 起動) されず、
    // executor にも出力が届いていない
    await expect.poll(async () => (await trace(page))[0]?.result, { timeout: 15_000 }).toMatchObject({ outcome: 'aborted' });
    expect((await trace(page))[0]).toMatchObject({ stdout: '', held: [false] });
    expect(await terminalText(page)).not.toContain(EXECUTED_MARK);

    // 停止直後の再実行 (runtime の reset を挟む) が成功し、出力は新しい run のものだけ
    await replaceLines(
      app,
      lang === 'c'
        ? ['#include <stdio.h>', 'int main(void) {', '    printf("after-stop-%d\\n", 6 * 7);', '}']
        : ['#include <cstdio>', 'int main() {', '    std::printf("after-stop-%d\\n", 6 * 7);', '}']
    );
    const startedAt = Date.now();
    const outcome = await runAndWait(page, FIRST_RUN_TIMEOUT_MS);
    test.info().annotations.push({ type: 'rerun-after-stop-ms', description: String(Date.now() - startedAt) });
    expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
    await expect.poll(() => terminalText(page)).toContain('after-stop-42');
    expect(await terminalText(page)).not.toContain(EXECUTED_MARK);
    const runs = await trace(page);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ stdout: '', held: [false], result: { outcome: 'aborted' } });
    expect(runs[1]).toMatchObject({ stdout: 'after-stop-42\n', held: [false, true], result: { outcome: 'success' } });
  });
}

/**
 * 既知の不具合の再現 (#711 の受け入れ条件「停止対象のプロセスが残らない」): `Process.kill()` は compile の `wait()` を
 * すぐに返すが、clang の wasm は worker の上で同期的に走り続け、本来のコンパイルの終わり (手元で約 30 秒後) まで
 * worker 2 本を塞ぐ。停止直後の再実行は新しい Wasmer で動くので結果には混ざらないが、CPU を使い続ける。
 * `<iostream>` のように終わらないコンパイル (#573) では塞がったまま残る。直し方 (worker ごと捨てる仕組み) に
 * 設計の選択が要るので、ここでは `test.fail()` で現状を固定する。直ったらこのテストが「予期せず通った」で赤くなるので、
 * `test.fail()` を外す
 */
test('c: @nightly コンパイル中に停止すると、10 秒以内に clang の worker が空き、停止したコンパイラが走り続けない (#711)', async ({
  page,
}) => {
  test.fail(true, 'Process.kill() が clang の wasm を止めない (#711 の残り)');
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await installExecutorTrace(page, 'c');
  await replaceCode(app, slowToCompile('c'));

  const stopped = await stopDuringCompile(page);
  expect(await waitOutcome(page, stopped, 15_000)).toBe('aborted');
  await expect.poll(() => busyWasmerWorkers(page), { timeout: 10_000 }).toBe(0);
});
