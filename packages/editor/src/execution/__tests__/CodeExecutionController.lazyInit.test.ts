/**
 * C / C++ の実行系の初期化を最初の実行まで遅らせたときの、CodeExecutionController の run の扱い (#617)。
 *
 * 実物の `LazyClangExecutor` に偽の「本物の executor」を読み込ませる (Wasmer は読まない)。本物の初期化は
 * テストが手で解決する Promise で止め、「初期化を待っている間」を作る。見るのは:
 * - 初期化の失敗で、ランタイムの表示が not-ready に戻り、読み込みの表示が外れ、次の実行が初期化をやり直す
 * - 初期化を待つ間に止めた run は、初期化が終わっても実行しない。続く run は同じ初期化を待ち、初期化は 1 回
 * - 初期化が済んだ後の実行は初期化を繰り返さない
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeExecutionEventData } from '@typedcode/shared';
import type { ExecutionResult } from '../../executors/interfaces/ILanguageExecutor.js';
import type { ClangExecutor } from '../../executors/c/LazyClangExecutor.js';
import type { CTerminal } from '../../terminal/CTerminal.js';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));
vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({ getJavaScriptExecutor: () => null }));
vi.mock('../../executors/typescript/TypeScriptExecutor.js', () => ({ getTypeScriptExecutor: () => null }));
vi.mock('../../executors/python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

/** 本物の C executor の偽物。initialize はテストが pendingInits の resolve / reject を呼ぶまで終わらない */
const real = vi.hoisted(() => {
  const state = {
    initialized: false,
    pendingInits: [] as Array<{ resolve: () => void; reject: (e: Error) => void }>,
    initializeCalls: 0,
    runCalls: 0,
    loads: 0,
    reset() {
      state.initialized = false;
      state.pendingInits = [];
      state.initializeCalls = 0;
      state.runCalls = 0;
      state.loads = 0;
    },
  };
  return state;
});

vi.mock('../../executors/c/LazyClangExecutor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../executors/c/LazyClangExecutor.js')>();
  const fakeReal: ClangExecutor = {
    config: actual.C_EXECUTOR_CONFIG,
    get isInitialized() {
      return real.initialized;
    },
    isInitializing: false,
    initialize: () => {
      real.initializeCalls++;
      return new Promise<void>((resolve, reject) => {
        real.pendingInits.push({
          resolve: () => {
            real.initialized = true;
            resolve();
          },
          reject,
        });
      });
    },
    run: async (): Promise<ExecutionResult> => {
      real.runCalls++;
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    },
    abort: () => {},
    parseErrors: () => [],
    resetRuntime: async () => {},
    dispose: () => {},
  };
  let lazy: InstanceType<typeof actual.LazyClangExecutor> | null = null;
  return {
    ...actual,
    getLazyCExecutor: () => {
      lazy ??= new actual.LazyClangExecutor(actual.C_EXECUTOR_CONFIG, async () => {
        real.loads++;
        return fakeReal;
      });
      return lazy;
    },
    /** テストごとに入口を作り直す */
    resetLazyForTest: () => {
      lazy = null;
    },
  };
});

const { CodeExecutionController } = await import('../CodeExecutionController.js');
const lazyModule = (await import('../../executors/c/LazyClangExecutor.js')) as unknown as {
  resetLazyForTest: () => void;
};

function fakeTerminal() {
  const state: Record<string, string | undefined> = {};
  const terminal = {
    clear: () => {},
    write: () => {},
    writeError: () => {},
    writeInfo: () => {},
    writeSuccess: () => {},
    disconnectStdin: () => {},
    connectStdin: () => {},
    markRunStarted: (id: number) => {
      state.execState = 'running';
      state.execRun = String(id);
    },
    markRunFinished: (outcome: string) => {
      state.execState = 'idle';
      state.execOutcome = outcome;
    },
  };
  return { terminal: terminal as unknown as CTerminal, state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const target = { language: 'c', filename: 'main.c', code: 'int main(void){return 0;}' };

function setup() {
  const controller = new CodeExecutionController();
  const { terminal, state } = fakeTerminal();
  const results: CodeExecutionEventData[] = [];
  const statuses: string[] = [];
  const overlay = { shown: 0, hidden: 0 };
  controller.setTerminal(terminal);
  controller.setCallbacks({
    onRecordEvent: (e) => {
      if (e.data?.phase === 'result') results.push(e.data);
    },
    onRuntimeStatusChange: (_language, status) => statuses.push(status),
    onShowClangLoading: () => overlay.shown++,
    onHideClangLoading: () => overlay.hidden++,
  });
  /** 読み込みの表示が今出ているか (表示と非表示の回数の差) */
  const overlayVisible = () => overlay.shown > overlay.hidden;
  return { controller, state, results, statuses, overlayVisible };
}

beforeEach(() => {
  real.reset();
  lazyModule.resetLazyForTest();
});

describe('CodeExecutionController with a lazily initialized C runtime (#617)', () => {
  it('returns the runtime status to not-ready, hides the loading overlay and records an error when initialization fails', async () => {
    const { controller, state, results, statuses, overlayVisible } = setup();

    const run = controller.run(target);
    await flush();
    expect(overlayVisible()).toBe(true);
    expect(statuses).toEqual(['loading']);
    real.pendingInits[0]!.reject(new Error('Failed to fetch clang.webc: 503 Service Unavailable'));
    await run;

    expect(statuses).toEqual(['loading', 'not-ready']);
    expect(overlayVisible()).toBe(false);
    expect(results.map((r) => r.outcome)).toEqual(['error']);
    expect(state.execState).toBe('idle');
    expect(controller.running).toBe(false);
    expect(real.runCalls).toBe(0);
  });

  it('initializes again on the next run after a failed initialization and then runs the program', async () => {
    const { controller, results, statuses, overlayVisible } = setup();

    const failed = controller.run(target);
    await flush();
    real.pendingInits[0]!.reject(new Error('Failed to fetch'));
    await failed;

    const retried = controller.run(target);
    await flush();
    expect(real.initializeCalls).toBe(2);
    real.pendingInits[1]!.resolve();
    await retried;

    expect(results.map((r) => r.outcome)).toEqual(['error', 'success']);
    expect(statuses).toEqual(['loading', 'not-ready', 'loading', 'ready']);
    expect(overlayVisible()).toBe(false);
    expect(real.runCalls).toBe(1);
  });

  it('does not run a run stopped while waiting for initialization, and lets the next run wait for the same initialization', async () => {
    const { controller, results, overlayVisible } = setup();

    const stopped = controller.run(target);
    await flush();
    controller.abort();
    expect(controller.running).toBe(false);
    expect(results.map((r) => r.outcome)).toEqual(['aborted']);

    const next = controller.run(target);
    await flush();
    real.pendingInits[0]!.resolve();
    await Promise.all([stopped, next]);

    expect(real.loads).toBe(1);
    expect(real.initializeCalls).toBe(1);
    expect(real.runCalls).toBe(1);
    expect(results.map((r) => r.outcome)).toEqual(['aborted', 'success']);
    expect(overlayVisible()).toBe(false);
  });

  it('hides the loading overlay once the initialization that a stopped run was waiting for ends', async () => {
    const { controller, overlayVisible } = setup();

    const stopped = controller.run(target);
    await flush();
    controller.abort();
    expect(overlayVisible()).toBe(true);
    real.pendingInits[0]!.reject(new Error('Failed to fetch'));
    await stopped;

    expect(overlayVisible()).toBe(false);
  });

  it('does not initialize again on runs after a successful initialization', async () => {
    const { controller, results, statuses } = setup();

    const first = controller.run(target);
    await flush();
    real.pendingInits[0]!.resolve();
    await first;
    await controller.run(target);
    await controller.run(target);

    expect(real.loads).toBe(1);
    expect(real.initializeCalls).toBe(1);
    expect(real.runCalls).toBe(3);
    expect(results.map((r) => r.outcome)).toEqual(['success', 'success', 'success']);
    expect(statuses).toEqual(['loading', 'ready']);
  });
});
