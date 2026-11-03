/**
 * CodeExecutionController の run の扱い (#290)。
 *
 * - 停止 → 即再実行で、古い run の遅れた出力・finally が新しい run の状態を壊さない
 * - 初期化の失敗は error を 1 回だけ記録し、そのあと再実行できる
 * - executor が返した outcome (timeout など) をそのまま記録する
 *
 * 言語ランタイムだけを偽物に差し替える。偽の executor の run は、テストが手で解決する Promise を返す。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CodeExecutionEventData } from '@typedcode/shared';
import type { ExecutionCallbacks, ExecutionResult } from '../../executors/interfaces/ILanguageExecutor.js';
import type { CTerminal } from '../../terminal/CTerminal.js';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));

interface PendingRun {
  callbacks: ExecutionCallbacks;
  resolve: (r: ExecutionResult) => void;
}

const fake = vi.hoisted(() => ({
  runs: [] as PendingRun[],
  aborts: 0,
  initialized: true,
  initError: null as Error | null,
}));

vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({
  getJavaScriptExecutor: () => ({
    config: { id: 'javascript', name: 'JavaScript' },
    get isInitialized() {
      return fake.initialized;
    },
    initialize: async () => {
      if (fake.initError) throw fake.initError;
      fake.initialized = true;
    },
    run: (_code: string, callbacks: ExecutionCallbacks) =>
      new Promise<ExecutionResult>((resolve) => {
        fake.runs.push({ callbacks, resolve });
      }),
    parseErrors: () => [],
    abort: () => {
      fake.aborts++;
    },
  }),
}));
vi.mock('../../executors/c/CExecutor.js', () => ({
  WasmerSdkCorruptedError: class extends Error {},
  getCExecutor: () => null,
}));
vi.mock('../../executors/cpp/CppExecutor.js', () => ({ getCppExecutor: () => null }));
vi.mock('../../executors/typescript/TypeScriptExecutor.js', () => ({ getTypeScriptExecutor: () => null }));
vi.mock('../../executors/python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

const { CodeExecutionController } = await import('../CodeExecutionController.js');

function fakeTerminal() {
  const written: string[] = [];
  const state: Record<string, string | undefined> = {};
  const terminal = {
    clear: () => {
      written.length = 0;
    },
    write: (t: string) => written.push(t),
    writeError: (t: string) => written.push(t),
    writeInfo: (t: string) => written.push(t),
    writeSuccess: (t: string) => written.push(t),
    disconnectStdin: () => {},
    connectStdin: () => {},
    markRunStarted: (id: number) => {
      state.execState = 'running';
      state.execRun = String(id);
      state.execOutcome = undefined;
    },
    markRunFinished: (outcome: string) => {
      state.execState = 'idle';
      state.execOutcome = outcome;
    },
  };
  return { terminal: terminal as unknown as CTerminal, written, state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const target = { language: 'javascript', filename: 'a.js', code: 'x' };

function setup() {
  const controller = new CodeExecutionController();
  const { terminal, written, state } = fakeTerminal();
  const results: CodeExecutionEventData[] = [];
  const runEnds = vi.fn();
  controller.setTerminal(terminal);
  controller.setCallbacks({
    onRecordEvent: (e) => {
      if (e.data?.phase === 'result') results.push(e.data);
    },
    onRunEnd: runEnds,
  });
  return { controller, written, state, results, runEnds };
}

const ok: ExecutionResult = { success: true, exitCode: 0, stdout: '', stderr: '' };

beforeEach(() => {
  fake.runs = [];
  fake.aborts = 0;
  fake.initialized = true;
  fake.initError = null;
});

describe('CodeExecutionController run guard', () => {
  it('keeps a new run stoppable and unpolluted when the stopped run finishes late', async () => {
    const { controller, written, state, results } = setup();

    const first = controller.run(target);
    await flush();
    controller.abort();
    expect(results.map((r) => r.outcome)).toEqual(['aborted']);

    const second = controller.run(target);
    await flush();
    expect(controller.running).toBe(true);
    expect(state.execRun).toBe('2');

    // 停止した 1 回目が遅れて出力し、終わる
    fake.runs[0]?.callbacks.onStdout('LATE');
    fake.runs[0]?.resolve(ok);
    await first;
    expect(controller.running).toBe(true);
    expect(written.join('')).not.toContain('LATE');

    // 2 回目は今も停止できて、aborted が記録される
    controller.abort();
    expect(fake.aborts).toBe(2);
    expect(controller.running).toBe(false);
    fake.runs[1]?.resolve(ok);
    await second;
    expect(results.map((r) => r.outcome)).toEqual(['aborted', 'aborted']);
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'aborted' });
  });

  it('records error once when initialization fails and accepts the next run', async () => {
    const { controller, results, runEnds } = setup();
    fake.initialized = false;
    fake.initError = new Error('runtime download failed');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await controller.run(target);
    expect(results).toEqual([expect.objectContaining({ outcome: 'error', exitCode: null })]);
    expect(runEnds).toHaveBeenCalledTimes(1);
    expect(controller.running).toBe(false);

    fake.initError = null;
    const again = controller.run(target);
    await flush();
    fake.runs[0]?.resolve(ok);
    await again;
    expect(results.map((r) => r.outcome)).toEqual(['error', 'success']);
    spy.mockRestore();
  });

  it('records the outcome the executor reports instead of deriving it from success', async () => {
    const { controller, written, state, results } = setup();
    const run = controller.run(target);
    await flush();
    fake.runs[0]?.resolve({ success: false, exitCode: 1, stdout: '', stderr: '', outcome: 'timeout' });
    await run;
    expect(results).toEqual([expect.objectContaining({ outcome: 'timeout', exitCode: null })]);
    expect(written.join('')).toContain('$ JavaScript execution timed out after 30s');
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'timeout' });
  });

  it('derives success and failure from the result when the executor reports no outcome', async () => {
    const { controller, results } = setup();
    for (const r of [ok, { ...ok, success: false, exitCode: 1 }]) {
      const run = controller.run(target);
      await flush();
      fake.runs.at(-1)?.resolve(r);
      await run;
    }
    expect(results.map((r) => [r.outcome, r.exitCode])).toEqual([
      ['success', 0],
      ['failure', 1],
    ]);
  });
});
