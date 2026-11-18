/**
 * PythonExecutor (メイン側のアダプタ) の振る舞い (#649)。
 *
 * Pyodide を動かす Worker だけを偽物に差し替える。偽の Worker は受け取ったメッセージを貯め、
 * テストが Worker からのメッセージを手で送る。stdin のチャネル・line discipline・期限は本物を使う。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecutionCallbacks, ExecutionResult } from '../../interfaces/ILanguageExecutor.js';
import { PythonExecutor, findRequiredPackages, type PythonWorkerHandle } from '../PythonExecutor.js';
import type { PythonWorkerMessage, PythonWorkerRequest } from '../pythonWorkerProtocol.js';
import { StdinChannelReader } from '../stdinChannel.js';

class FakeWorker implements PythonWorkerHandle {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  posted: PythonWorkerRequest[] = [];
  terminated = false;

  postMessage(message: PythonWorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: PythonWorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  lastRun(): Extract<PythonWorkerRequest, { type: 'run' }> {
    const run = this.posted.filter((m) => m.type === 'run').at(-1);
    if (run?.type !== 'run') throw new Error('no run posted');
    return run;
  }
}

function setup(timeoutMs?: number) {
  const workers: FakeWorker[] = [];
  const executor = new PythonExecutor(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, timeoutMs);
  return { executor, workers };
}

async function initialize(executor: PythonExecutor, workers: FakeWorker[]): Promise<FakeWorker> {
  const ready = executor.initialize();
  const worker = workers.at(-1) as FakeWorker;
  worker.emit({ type: 'ready' });
  await ready;
  return worker;
}

function startRun(executor: PythonExecutor, code = 'x = input()') {
  const out: string[] = [];
  const err: string[] = [];
  let stdin: WritableStream<Uint8Array> | null = null;
  const callbacks: ExecutionCallbacks = {
    onStdout: (t) => out.push(t),
    onStderr: (t) => err.push(t),
    onStdinReady: (s) => {
      stdin = s;
    },
  };
  let result: ExecutionResult | null = null;
  const promise = executor.run(code, callbacks).then((r) => {
    result = r;
    return r;
  });
  const type = async (text: string) => {
    if (!stdin) throw new Error('stdin not ready');
    const writer = stdin.getWriter();
    await writer.write(new TextEncoder().encode(text));
    writer.releaseLock();
  };
  return { promise, out, err, type, result: () => result };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PythonExecutor', () => {
  it('echoes typed input and hands the completed line to the worker through the stdin channel', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startRun(executor);
    const { runId, stdinBuffer } = worker.lastRun();

    worker.emit({ type: 'started', runId });
    worker.emit({ type: 'stdout', runId, text: 'name: ' });
    worker.emit({ type: 'stdin-request', runId });
    await run.type('Taro\r');

    expect(run.out.join('')).toBe('name: Taro\n');
    expect(new TextDecoder().decode(new StdinChannelReader(stdinBuffer).read())).toBe('Taro\n');

    worker.emit({ type: 'done', runId, success: true, result: null });
    expect(await run.promise).toMatchObject({ success: true, exitCode: 0 });
  });

  it('stops the worker on abort, resolves the run as aborted, and initializes a new worker for the next run', async () => {
    const { executor, workers } = setup();
    const first = await initialize(executor, workers);
    const run = startRun(executor);
    first.emit({ type: 'started', runId: first.lastRun().runId });

    executor.abort();
    expect(await run.promise).toMatchObject({ success: false, outcome: 'aborted' });
    expect(first.terminated).toBe(true);
    expect(executor.isInitialized).toBe(false);

    const second = await initialize(executor, workers);
    expect(second).not.toBe(first);
    const next = startRun(executor, 'print(1)');
    second.emit({ type: 'done', runId: second.lastRun().runId, success: true, result: null });
    expect(await next.promise).toMatchObject({ success: true });
  });

  it('does not count time waiting for input toward the timeout', async () => {
    vi.useFakeTimers();
    const { executor, workers } = setup(1_000);
    const worker = await initialize(executor, workers);
    const run = startRun(executor);
    const { runId } = worker.lastRun();

    worker.emit({ type: 'started', runId });
    await vi.advanceTimersByTimeAsync(900);
    worker.emit({ type: 'stdin-request', runId });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.result()).toBeNull();
    expect(worker.terminated).toBe(false);

    await run.type('ok\r');
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.promise).toMatchObject({ success: false, outcome: 'timeout', timeoutMs: 1_000 });
    expect(worker.terminated).toBe(true);
    expect(executor.isInitialized).toBe(false);
  });

  it('ignores late messages from a stopped worker', async () => {
    const { executor, workers } = setup();
    const first = await initialize(executor, workers);
    const stopped = startRun(executor);
    const oldRunId = first.lastRun().runId;
    executor.abort();
    await stopped.promise;

    // 捨てた Worker の ready で、新しい Worker の初期化を終えたことにしない
    const init = executor.initialize();
    first.emit({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(executor.isInitialized).toBe(false);
    const second = workers.at(-1) as FakeWorker;
    second.emit({ type: 'ready' });
    await init;

    const run = startRun(executor, 'print(1)');
    first.emit({ type: 'stdout', runId: oldRunId, text: 'LATE' });
    first.emit({ type: 'done', runId: oldRunId, success: false, error: 'late', result: null });
    expect(run.out).toEqual([]);
    expect(run.result()).toBeNull();

    second.emit({ type: 'done', runId: second.lastRun().runId, success: true, result: null });
    expect(await run.promise).toMatchObject({ success: true });
  });

  it('fails initialization when the worker reports an error and allows retrying', async () => {
    const { executor, workers } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const init = executor.initialize();
    workers[0]?.emit({ type: 'init-error', error: 'network down' });
    await expect(init).rejects.toThrow('Failed to initialize Python: network down');
    expect(workers[0]?.terminated).toBe(true);
    expect(executor.isInitialized).toBe(false);

    await initialize(executor, workers);
    expect(executor.isInitialized).toBe(true);
  });

  it('writes the Python error to stderr and resolves the run as a failure', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startRun(executor, 'raise ValueError("x")');
    const { runId } = worker.lastRun();
    worker.emit({ type: 'done', runId, success: false, error: 'ValueError: x', result: null });
    expect(await run.promise).toMatchObject({ success: false, exitCode: 1, error: 'ValueError: x' });
    expect(run.err).toEqual(['ValueError: x\n']);
    expect(worker.terminated).toBe(false);
  });
});

describe('PythonExecutor non-interactive run (#802)', () => {
  function startBatchRun(executor: PythonExecutor, stdin: string, showLastValue?: boolean) {
    const out: string[] = [];
    let stdinReady = false;
    let programStarts = 0;
    const promise = executor.run(
      'x = input()',
      {
        onStdout: (t) => out.push(t),
        onStderr: () => {},
        onStdinReady: () => {
          stdinReady = true;
        },
        onProgramStart: () => {
          programStarts++;
        },
      },
      { stdin, ...(showLastValue !== undefined ? { showLastValue } : {}) }
    );
    return { promise, out, stdinReady: () => stdinReady, programStarts: () => programStarts };
  }

  it('hands the whole stdin to the worker and then reports EOF as an empty read', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    startBatchRun(executor, '3\n1 8 4\n');
    const { runId, stdinBuffer } = worker.lastRun();
    const reader = new StdinChannelReader(stdinBuffer);
    const state = new Int32Array(stdinBuffer, 0, 1);

    // Worker の read を真似る: 入力を求め、書かれていれば読む (書かれていなければ待たずに null)
    const reads: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      worker.emit({ type: 'stdin-request', runId });
      reads.push(Atomics.load(state, 0) === 1 ? new TextDecoder().decode(reader.read()) : null);
    }

    expect(reads).toEqual(['3\n1 8 4\n', '']);
  });

  it('neither connects the terminal nor echoes the given stdin to stdout', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startBatchRun(executor, 'Taro\n');
    const { runId } = worker.lastRun();
    worker.emit({ type: 'stdin-request', runId });
    worker.emit({ type: 'done', runId, success: true, result: null });
    await run.promise;

    expect({ stdinReady: run.stdinReady(), out: run.out.join('') }).toEqual({ stdinReady: false, out: '' });
  });

  it('reports the start of the user program when the worker starts running it', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startBatchRun(executor, '');
    expect(run.programStarts()).toBe(0);

    worker.emit({ type: 'started', runId: worker.lastRun().runId });

    expect(run.programStarts()).toBe(1);
  });

  it('leaves the value of the last expression out of stdout when showLastValue is false', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startBatchRun(executor, '', false);
    worker.emit({ type: 'done', runId: worker.lastRun().runId, success: true, result: '42' });

    expect((await run.promise).stdout).toBe('');
  });

  it('still appends the value of the last expression to stdout by default', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startBatchRun(executor, '');
    worker.emit({ type: 'done', runId: worker.lastRun().runId, success: true, result: '42' });

    expect((await run.promise).stdout).toBe('=> 42\n');
  });
});

describe('findRequiredPackages', () => {
  it('lists third-party imports and leaves out the standard library', () => {
    expect(findRequiredPackages('import sys\nimport numpy as np\nfrom pandas import DataFrame\nimport math\n')).toEqual(
      ['numpy', 'pandas']
    );
  });
});
