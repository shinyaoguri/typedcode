/**
 * TypeScript の実行の outcome。
 *
 * TS の run は「Monaco の TS worker で transpile (非同期。初回は worker のロードで数秒) → JS の sandbox で実行」
 * の 2 段なので、停止は変換中にも sandbox の実行中にも来る。どこで止めても (#585)、
 * - executor は `aborted` を返し、変換中に止めたなら sandbox を作らない
 * - controller は `aborted` を 1 回だけ記録し、止めた run の遅れた結果で上書きしない
 * 変換基盤の失敗 (worker が使えない等) は、ユーザーのコードの失敗 (`failure`) ではなく `error` で記録する (#624 / ADR-0021)。
 *
 * 本物の CodeExecutionController / TypeScriptExecutor / JavaScriptExecutor を使い、Monaco の transpile と
 * sandbox (SandboxRunner) だけを、テストが手で解決する偽物に差し替える。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeExecutionEventData } from '@typedcode/shared';
import type { MonacoTranspileResult } from '../monacoTranspile.js';
import type { SandboxResult, SandboxRunner } from '../../sandbox/SandboxRunner.js';
import type { CTerminal } from '../../../terminal/CTerminal.js';

vi.mock('../../../i18n/index.js', () => ({ t: (key: string) => key }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const fake = vi.hoisted(() => ({
  transpiles: [] as { code: string; resolve: (r: MonacoTranspileResult) => void; reject: (e: unknown) => void }[],
  sandboxRuns: [] as { code: string; resolve: (r: SandboxResult) => void; abort: () => void }[],
}));

vi.mock('../monacoTranspile.js', () => ({
  transpileWithMonaco: (code: string) =>
    new Promise<MonacoTranspileResult>((resolve, reject) => {
      fake.transpiles.push({ code, resolve, reject });
    }),
}));

// JavaScriptExecutor は本物を使い、sandbox (iframe + Worker) だけを偽物にする
vi.mock('../../javascript/JavaScriptExecutor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../javascript/JavaScriptExecutor.js')>();
  const runner = {
    start: (code: string) => {
      const d = deferred<SandboxResult>();
      const run = {
        code,
        resolve: d.resolve,
        abort: () => d.resolve({ outcome: 'aborted', exitCode: null, stdout: '', stderr: '' }),
      };
      fake.sandboxRuns.push(run);
      return { result: d.promise, abort: run.abort };
    },
  } as unknown as SandboxRunner;
  const instance = new actual.JavaScriptExecutor(runner);
  return { ...actual, getJavaScriptExecutor: () => instance };
});
vi.mock('../../c/CExecutor.js', () => ({
  WasmerSdkCorruptedError: class extends Error {},
  getCExecutor: () => null,
}));
vi.mock('../../cpp/CppExecutor.js', () => ({ getCppExecutor: () => null }));
vi.mock('../../python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

const { TypeScriptExecutor } = await import('../TypeScriptExecutor.js');
const { CodeExecutionController } = await import('../../../execution/CodeExecutionController.js');

const transpiled = (outputText: string): MonacoTranspileResult => ({ outputText, diagnostics: [] });
const silent = { onStdout: () => {}, onStderr: () => {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeTerminal() {
  const state: Record<string, string | undefined> = {};
  const noop = () => {};
  const terminal = {
    clear: noop,
    write: noop,
    writeError: noop,
    writeInfo: noop,
    writeSuccess: noop,
    disconnectStdin: noop,
    connectStdin: noop,
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
  return { terminal: terminal as unknown as CTerminal, state };
}

function setupController() {
  const controller = new CodeExecutionController();
  const { terminal, state } = fakeTerminal();
  const results: CodeExecutionEventData[] = [];
  controller.setTerminal(terminal);
  controller.setCallbacks({
    onRecordEvent: (e) => {
      if (e.data?.phase === 'result') results.push(e.data);
    },
  });
  return { controller, state, results };
}

const target = { language: 'typescript', filename: 'a.ts', code: 'const x: number = 1;' };

beforeEach(() => {
  fake.transpiles = [];
  fake.sandboxRuns = [];
});

describe('TypeScriptExecutor stopped mid-run (#585)', () => {
  it('returns aborted without starting the sandbox when stopped while transpiling', async () => {
    const executor = new TypeScriptExecutor();
    await executor.initialize();
    const running = executor.run('const x: number = 1;', silent);
    await flush();
    expect(fake.transpiles).toHaveLength(1);

    executor.abort();
    fake.transpiles[0]?.resolve(transpiled('const x = 1;'));

    await expect(running).resolves.toMatchObject({ success: false, outcome: 'aborted' });
    expect(fake.sandboxRuns).toHaveLength(0);
  });

  it('returns aborted from the sandbox when stopped while the JavaScript runs', async () => {
    const executor = new TypeScriptExecutor();
    await executor.initialize();
    const running = executor.run('const x: number = 1;', silent);
    await flush();
    fake.transpiles[0]?.resolve(transpiled('const x = 1;'));
    await flush();
    expect(fake.sandboxRuns.map((r) => r.code)).toEqual(['const x = 1;']);

    executor.abort();

    await expect(running).resolves.toMatchObject({ success: false, outcome: 'aborted' });
  });

  it('runs the next TypeScript run normally after a run stopped while transpiling', async () => {
    const executor = new TypeScriptExecutor();
    await executor.initialize();
    const stopped = executor.run('1', silent);
    await flush();
    executor.abort();
    fake.transpiles[0]?.resolve(transpiled('1'));
    await stopped;

    const next = executor.run('2', silent);
    await flush();
    fake.transpiles[1]?.resolve(transpiled('2'));
    await flush();
    fake.sandboxRuns[0]?.resolve({ outcome: 'success', exitCode: 0, stdout: '', stderr: '' });
    await expect(next).resolves.toMatchObject({ success: true, outcome: 'success' });
  });
});

describe('CodeExecutionController records aborted for a stopped TypeScript run (#585)', () => {
  it('records aborted once when stopped while transpiling, even after the transpile finishes', async () => {
    const { controller, state, results } = setupController();
    const run = controller.run(target);
    await flush();
    expect(fake.transpiles).toHaveLength(1);

    controller.abort();
    fake.transpiles[0]?.resolve(transpiled('const x = 1;'));
    await run;
    await flush();

    expect(results.map((r) => r.outcome)).toEqual(['aborted']);
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'aborted' });
    expect(fake.sandboxRuns).toHaveLength(0);
  });

  it('records aborted once when stopped while the JavaScript runs', async () => {
    const { controller, state, results } = setupController();
    const run = controller.run(target);
    await flush();
    fake.transpiles[0]?.resolve(transpiled('const x = 1;'));
    await flush();
    expect(fake.sandboxRuns).toHaveLength(1);

    controller.abort();
    await run;
    await flush();

    expect(results.map((r) => r.outcome)).toEqual(['aborted']);
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'aborted' });
  });

  it('records error, not failure, when the transpile itself fails (#624)', async () => {
    const { controller, state, results } = setupController();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = controller.run(target);
    await flush();
    fake.transpiles[0]?.reject('TypeScript not registered!');
    await run;

    expect(results).toEqual([expect.objectContaining({ outcome: 'error', exitCode: null })]);
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'error' });
    expect(fake.sandboxRuns).toHaveLength(0);
    spy.mockRestore();
  });

  it('keeps recording failure for a syntax error in the code', async () => {
    const { controller, results } = setupController();
    const run = controller.run(target);
    await flush();
    fake.transpiles[0]?.resolve({
      outputText: '',
      diagnostics: [{ category: 1, code: 1005, start: 0, messageText: "';' expected." }],
    });
    await run;

    expect(results).toEqual([expect.objectContaining({ outcome: 'failure', exitCode: 1 })]);
    expect(fake.sandboxRuns).toHaveLength(0);
  });

  it('records the failure of a run that ended on its own, and a later stop changes nothing', async () => {
    // 停止が実行の終わりより遅れて届いた場合 (CI の E2E で failure になった経路の再現。#585)
    const { controller, state, results } = setupController();
    const run = controller.run(target);
    await flush();
    fake.transpiles[0]?.resolve(transpiled('localStorage.setItem("pwned", "1");'));
    await flush();
    fake.sandboxRuns[0]?.resolve({ outcome: 'failure', exitCode: 1, stdout: '', stderr: 'ReferenceError' });
    await run;

    controller.abort();

    expect(results.map((r) => r.outcome)).toEqual(['failure']);
    expect(state).toMatchObject({ execState: 'idle', execOutcome: 'failure' });
  });
});
