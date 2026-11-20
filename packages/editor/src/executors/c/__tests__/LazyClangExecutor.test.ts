/**
 * C / C++ の実行系を最初の需要まで読み込まない入口 (#617)。
 *
 * 本物の executor の読み込み (`import()`) と初期化を偽物にし、テストが手で解決する Promise で
 * 「読み込み中」「初期化中」に留める。見るのは、読み込みと初期化が最初の initialize まで起きないこと・
 * 並行する initialize が 1 回にまとまること・失敗の後にやり直せること・停止が初期化を止めないこと。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionResult, InitializationProgress } from '../../interfaces/ILanguageExecutor.js';
import { type ClangExecutor, LazyClangExecutor, C_EXECUTOR_CONFIG } from '../LazyClangExecutor.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 本物の executor の偽物。initialize は `inits` に積んだ Deferred が解決されるまで終わらない */
function fakeReal() {
  const inits: Array<{ done: Deferred<void>; onProgress?: (p: InitializationProgress) => void }> = [];
  let initialized = false;
  const real = {
    config: C_EXECUTOR_CONFIG,
    get isInitialized() {
      return initialized;
    },
    isInitializing: false,
    initialize: vi.fn((onProgress?: (p: InitializationProgress) => void) => {
      const done = deferred<void>();
      inits.push({ done, onProgress });
      return done.promise.then(() => {
        initialized = true;
      });
    }),
    run: vi.fn(async (): Promise<ExecutionResult> => ({ success: true, exitCode: 0, stdout: '', stderr: '' })),
    abort: vi.fn(),
    parseErrors: vi.fn(() => []),
    isRuntimeCorrupted: vi.fn(() => false),
    resetRuntime: vi.fn(async () => {
      initialized = false;
    }),
    dispose: vi.fn(),
  } satisfies ClangExecutor;
  return { real, inits };
}

/** 読み込み (`import()`) の偽物。呼ばれるたびに Deferred を積み、テストが解決する */
function fakeLoader(real: ClangExecutor) {
  const loads: Deferred<ClangExecutor>[] = [];
  const load = vi.fn(() => {
    const d = deferred<ClangExecutor>();
    loads.push(d);
    return d.promise;
  });
  return { load, loads, resolveNext: () => loads.at(-1)!.resolve(real) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const { real, inits } = fakeReal();
  const loader = fakeLoader(real);
  const lazy = new LazyClangExecutor(C_EXECUTOR_CONFIG, loader.load);
  return { lazy, real, inits, loader };
}

describe('LazyClangExecutor (#617)', () => {
  it('does not load the real executor until the first initialize', async () => {
    const { lazy, loader } = setup();

    expect(lazy.config.name).toBe('C');
    expect(lazy.isInitialized).toBe(false);
    expect(lazy.isRuntimeCorrupted()).toBe(false);
    expect(lazy.parseErrors('main.c:1:1: error: x')).toEqual([]);
    lazy.abort();
    await lazy.resetRuntime();

    expect(loader.load).not.toHaveBeenCalled();
    expect(lazy.isLoaded).toBe(false);
  });

  it('loads and initializes once on the first initialize and reuses the result for later calls', async () => {
    const { lazy, real, inits, loader } = setup();

    const first = lazy.initialize();
    expect(lazy.isInitializing).toBe(true);
    loader.resolveNext();
    await flush();
    inits[0]!.done.resolve();
    await first;

    expect(lazy.isInitialized).toBe(true);
    expect(lazy.isInitializing).toBe(false);
    await lazy.initialize();
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(real.initialize).toHaveBeenCalledTimes(1);
  });

  it('merges concurrent initialize calls into one load and one initialization and reports progress to every caller', async () => {
    const { lazy, real, inits, loader } = setup();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const seenC: string[] = [];

    const a = lazy.initialize((p) => seenA.push(p.message));
    const b = lazy.initialize((p) => seenB.push(p.message));
    loader.resolveNext();
    await flush();
    inits[0]!.onProgress?.({ stage: 'sdk', message: 'Initializing Wasmer SDK...' });
    // 途中から加わった呼び出しは、まず最後の進み具合を受け取る
    const c = lazy.initialize((p) => seenC.push(p.message));
    inits[0]!.onProgress?.({ stage: 'compiler', message: 'Downloading C compiler...' });
    inits[0]!.done.resolve();
    await Promise.all([a, b, c]);

    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(real.initialize).toHaveBeenCalledTimes(1);
    expect(seenA).toEqual(['Initializing Wasmer SDK...', 'Downloading C compiler...']);
    expect(seenB).toEqual(['Initializing Wasmer SDK...', 'Downloading C compiler...']);
    expect(seenC).toEqual(['Initializing Wasmer SDK...', 'Downloading C compiler...']);
  });

  it('rejects every waiting caller when initialization fails and retries the initialization on the next call', async () => {
    const { lazy, real, inits, loader } = setup();

    const a = lazy.initialize();
    const b = lazy.initialize();
    loader.resolveNext();
    await flush();
    inits[0]!.done.reject(new Error('Failed to fetch clang.webc: 503'));
    await expect(a).rejects.toThrow('503');
    await expect(b).rejects.toThrow('503');
    expect(lazy.isInitialized).toBe(false);
    expect(lazy.isInitializing).toBe(false);

    const retry = lazy.initialize();
    await flush();
    inits[1]!.done.resolve();
    await retry;

    expect(lazy.isInitialized).toBe(true);
    // 読み込めた本物は持ち続け、初期化だけをやり直す
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(real.initialize).toHaveBeenCalledTimes(2);
  });

  it('loads the real executor again on the next call after loading it failed', async () => {
    const { lazy, real, inits, loader } = setup();

    const first = lazy.initialize();
    loader.loads[0]!.reject(new Error('Failed to fetch dynamically imported module'));
    await expect(first).rejects.toThrow('dynamically imported module');
    expect(real.initialize).not.toHaveBeenCalled();

    const retry = lazy.initialize();
    loader.resolveNext();
    await flush();
    inits[0]!.done.resolve();
    await retry;

    expect(loader.load).toHaveBeenCalledTimes(2);
    expect(lazy.isInitialized).toBe(true);
  });

  it('keeps initializing after a stop during the wait, so that the next run joins it instead of starting another', async () => {
    const { lazy, real, inits, loader } = setup();

    const stoppedRun = lazy.initialize();
    loader.resolveNext();
    await flush();
    lazy.abort();
    const nextRun = lazy.initialize();
    inits[0]!.done.resolve();
    await Promise.all([stoppedRun, nextRun]);

    expect(real.abort).toHaveBeenCalledTimes(1);
    expect(real.initialize).toHaveBeenCalledTimes(1);
    expect(lazy.isInitialized).toBe(true);
  });

  it('delegates run, stop, diagnostics, corruption and reset to the loaded executor', async () => {
    const { lazy, real, inits, loader } = setup();
    await expect(lazy.run('int main(){}', { onStdout: () => {}, onStderr: () => {} })).rejects.toThrow(
      'not initialized'
    );

    const init = lazy.initialize();
    loader.resolveNext();
    await flush();
    inits[0]!.done.resolve();
    await init;

    const callbacks = { onStdout: () => {}, onStderr: () => {} };
    await lazy.run('int main(){}', callbacks, { stdin: 'x' });
    expect(real.run).toHaveBeenCalledWith('int main(){}', callbacks, { stdin: 'x' });
    lazy.abort();
    expect(real.abort).toHaveBeenCalledTimes(1);
    lazy.parseErrors('e');
    expect(real.parseErrors).toHaveBeenCalledWith('e');
    real.isRuntimeCorrupted.mockReturnValue(true);
    expect(lazy.isRuntimeCorrupted()).toBe(true);
    await lazy.resetRuntime();
    expect(real.resetRuntime).toHaveBeenCalledTimes(1);
    expect(lazy.isInitialized).toBe(false);
  });
});
