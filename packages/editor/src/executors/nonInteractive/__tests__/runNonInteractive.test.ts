/**
 * 非対話の実行の入口 (#802)。executor と時計を偽物に差し替える。
 *
 * 偽の executor は ILanguageExecutor の契約どおりに振る舞う: run の中で onProgramStart を呼び、
 * 渡された stdin からプログラムの出力を作る。`hang` にすると abort されるまで終わらない
 * (abort されると、本物の C と同じく停止の通知を stderr に書いてから aborted で終わる)。
 */

import { describe, it, expect } from 'vitest';
import type {
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
  ILanguageExecutor,
} from '../../interfaces/ILanguageExecutor.js';
import {
  NON_INTERACTIVE_TIMEOUT_MS,
  runNonInteractive,
  type NonInteractiveOptions,
  type NonInteractiveRequest,
} from '../runNonInteractive.js';

interface Program {
  /** stdin から stdout の断片を作る */
  stdout?: (stdin: string) => string[];
  stderr?: string;
  exitCode?: number;
  /** 実行系が返す結果を上書きする (コンパイルエラーなど) */
  result?: Partial<ExecutionResult>;
  /** abort されるまで終わらない */
  hang?: boolean;
  /** run が例外を投げる */
  throws?: string;
}

class FakeExecutor implements ILanguageExecutor {
  readonly config = { id: 'c', name: 'C', fileExtension: '.c', monacoLanguage: 'c' };
  isInitialized = false;
  readonly isInitializing = false;
  initError: string | null = null;
  aborts = 0;
  runs: { code: string; options: ExecutionOptions | undefined }[] = [];
  /** run の中で onProgramStart を呼ぶ前に待つ (コンパイル中を表す) */
  compiling: Promise<void> = Promise.resolve();
  private stopCurrent: (() => void) | null = null;

  constructor(private readonly program: Program = {}) {}

  async initialize(): Promise<void> {
    if (this.initError) throw new Error(this.initError);
    this.isInitialized = true;
  }

  async run(code: string, callbacks: ExecutionCallbacks, options?: ExecutionOptions): Promise<ExecutionResult> {
    this.runs.push({ code, options });
    if (this.program.throws) throw new Error(this.program.throws);
    await this.compiling;
    callbacks.onProgramStart?.();
    for (const chunk of this.program.stdout?.(options?.stdin ?? '') ?? []) callbacks.onStdout(chunk);
    if (this.program.stderr) callbacks.onStderr(this.program.stderr);
    if (this.program.hang) {
      await new Promise<void>((resolve) => {
        this.stopCurrent = () => {
          callbacks.onStderr('\n[System] Program stopped.\n');
          resolve();
        };
      });
      return { success: false, exitCode: 137, stdout: '', stderr: '', outcome: 'aborted' };
    }
    const exitCode = this.program.exitCode ?? 0;
    return { success: exitCode === 0, exitCode, stdout: '', stderr: '', ...this.program.result };
  }

  abort(): void {
    this.aborts++;
    this.stopCurrent?.();
  }

  parseErrors() {
    return [];
  }

  dispose(): void {}
}

/** 手で進める時計。仕掛けられたタイマーを覚え、fire で発火させる */
function fakeClock() {
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (callback: () => void, ms: number) => {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire() {
      for (const timer of timers) if (!timer.cancelled) timer.callback();
    },
  };
}

const request = (overrides: Partial<NonInteractiveRequest> = {}): NonInteractiveRequest => ({
  language: 'c',
  filename: 'main.c',
  code: 'int main(void){}',
  stdin: '',
  ...overrides,
});

function setup(program: Program = {}, options: Omit<NonInteractiveOptions, 'resolveExecutor' | 'schedule'> = {}) {
  const executor = new FakeExecutor(program);
  const clock = fakeClock();
  const run = (req: NonInteractiveRequest = request()) =>
    runNonInteractive(req, { ...options, resolveExecutor: () => executor, schedule: clock.schedule });
  return { executor, clock, run };
}

/** 偽の executor の run が onProgramStart まで進むのを待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runNonInteractive', () => {
  it('passes the given stdin to the program and returns its stdout as one string', async () => {
    const { run } = setup({
      stdout: (stdin) => ['max=', String(Math.max(...stdin.trim().split(' ').map(Number))), '\n'],
    });

    const result = await run(request({ stdin: '1 8 4\n' }));

    expect(result).toEqual({ stdout: 'max=8\n', stderr: '', outcome: 'success', exitCode: 0 });
  });

  it('hands the stdin to the executor as a non-interactive run that leaves out the last expression value', async () => {
    const { executor, run } = setup();

    await run(request({ stdin: '3\n' }));

    expect(executor.runs[0]?.options).toEqual({ stdin: '3\n', showLastValue: false });
  });

  it('keeps stderr separate from stdout', async () => {
    const { run } = setup({ stdout: () => ['out\n'], stderr: 'warn\n' });

    const result = await run();

    expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({ stdout: 'out\n', stderr: 'warn\n' });
  });

  it('reports a non-zero exit as a runtime error with its exit code', async () => {
    const { run } = setup({ exitCode: 3 });

    expect(await run()).toMatchObject({ outcome: 'runtime-error', exitCode: 3 });
  });

  it('reports a compile error as a runtime error with the compiler diagnostics', async () => {
    const { run } = setup({
      stderr: 'main.c:1:1: error: boom',
      result: { success: false, exitCode: 1, error: 'Compilation failed' },
    });

    expect(await run()).toMatchObject({ outcome: 'runtime-error', stderr: 'main.c:1:1: error: boom' });
  });

  it('reports an exception from the executor as a runtime error with its message', async () => {
    const { run } = setup({ throws: 'wasm trap' });

    expect(await run()).toMatchObject({ outcome: 'runtime-error', stderr: 'wasm trap\n', exitCode: null });
  });

  it('reports a runtime that fails to initialize as a runtime error without running the program', async () => {
    const { executor, run } = setup();
    executor.initError = 'network down';

    const result = await run();

    expect({ result, runs: executor.runs.length }).toEqual({
      result: { stdout: '', stderr: 'network down\n', outcome: 'runtime-error', exitCode: null },
      runs: 0,
    });
  });

  it('returns unsupported without running anything for a language other than C, C++ or Python', async () => {
    const { executor, run } = setup();

    const result = await run(request({ language: 'javascript' }));

    expect({ outcome: result.outcome, runs: executor.runs.length }).toEqual({ outcome: 'unsupported', runs: 0 });
  });

  it('returns unsupported when no executor is available for the language', async () => {
    const result = await runNonInteractive(request(), { resolveExecutor: () => null, schedule: fakeClock().schedule });

    expect(result.outcome).toBe('unsupported');
  });
});

describe('runNonInteractive time limit', () => {
  it('stops a program that exceeds the time limit and reports a timeout with the output so far', async () => {
    const { executor, clock, run } = setup({ stdout: () => ['partial\n'], hang: true });

    const running = run();
    await settle();
    clock.fire();
    const result = await running;

    expect({ result, aborts: executor.aborts }).toEqual({
      result: { stdout: 'partial\n', stderr: '', outcome: 'timeout', exitCode: null },
      aborts: 1,
    });
  });

  it('uses a 10 second limit by default', async () => {
    const { clock, run } = setup();

    await run();

    expect(clock.timers.map((t) => t.ms)).toEqual([NON_INTERACTIVE_TIMEOUT_MS]);
    expect(NON_INTERACTIVE_TIMEOUT_MS).toBe(10_000);
  });

  it('does not count compilation toward the limit: the timer starts when the program starts', async () => {
    const { executor, clock, run } = setup();
    let compiled: () => void = () => {};
    executor.compiling = new Promise((resolve) => {
      compiled = resolve;
    });

    const running = run();
    await settle();
    const armedWhileCompiling = clock.timers.length;
    compiled();
    await running;

    expect({ armedWhileCompiling, armedAfterStart: clock.timers.length }).toEqual({
      armedWhileCompiling: 0,
      armedAfterStart: 1,
    });
  });

  it('cancels the timer once the program finishes on its own', async () => {
    const { clock, run } = setup();

    await run();

    expect(clock.timers[0]?.cancelled).toBe(true);
  });

  it('reports a timeout when the executor hits its own limit first', async () => {
    const { run } = setup({ result: { success: false, exitCode: 1, outcome: 'timeout' } });

    expect(await run()).toMatchObject({ outcome: 'timeout', exitCode: null });
  });
});

describe('runNonInteractive abort', () => {
  it('stops the running program when the signal is aborted and reports aborted', async () => {
    const controller = new AbortController();
    const { executor, run } = setup({ hang: true }, { signal: controller.signal });

    const running = run();
    await settle();
    controller.abort();
    const result = await running;

    expect({ outcome: result.outcome, aborts: executor.aborts }).toEqual({ outcome: 'aborted', aborts: 1 });
  });

  it('does not start the program when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { executor, run } = setup({}, { signal: controller.signal });

    const result = await run();

    expect({ outcome: result.outcome, runs: executor.runs.length }).toEqual({ outcome: 'aborted', runs: 0 });
  });

  it('reports a program stopped from outside (the terminal stop button) as aborted', async () => {
    const { executor, run } = setup({ hang: true });

    const running = run();
    await settle();
    executor.abort();

    expect((await running).outcome).toBe('aborted');
  });
});
