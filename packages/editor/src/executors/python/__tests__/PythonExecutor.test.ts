/**
 * PythonExecutor (メイン側のアダプタ) の振る舞い (#649 / #719)。
 *
 * Pyodide を動かす runner (sandbox iframe + Worker) だけを偽物に差し替える。偽の runner は受け取った
 * 要求を貯め、テストが runner からの (検査済みの) メッセージを手で送る。期限は本物を使う
 * (line discipline はターミナル側。#707。stdin の SharedArrayBuffer は runner 側 = stdinChannelSource.test.ts)。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecutionCallbacks, ExecutionResult, InteractiveStdin } from '../../interfaces/ILanguageExecutor.js';
import { outputLimitNotice } from '../../sandbox/SandboxRunner.js';
import { PythonExecutor, findRequiredPackages } from '../PythonExecutor.js';
import type { PythonRunnerHandle } from '../PythonRunner.js';
import type { PythonExecMessage, PythonRunnerRequest } from '../pythonRunnerProtocol.js';

class FakeRunner implements PythonRunnerHandle {
  onmessage: ((message: PythonExecMessage) => void) | null = null;
  onerror: ((error: string) => void) | null = null;
  posted: PythonRunnerRequest[] = [];
  terminated = false;

  postMessage(message: PythonRunnerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: PythonExecMessage): void {
    this.onmessage?.(message);
  }

  lastRun(): Extract<PythonRunnerRequest, { type: 'run' }> {
    const run = this.posted.filter((m) => m.type === 'run').at(-1);
    if (run?.type !== 'run') throw new Error('no run posted');
    return run;
  }

  /** run の後に送った stdin の要求 */
  stdinRequests(): PythonRunnerRequest[] {
    return this.posted.filter((m) => m.type === 'stdin' || m.type === 'stdin-eof');
  }
}

function setup(timeoutMs?: number, outputBudgetChars = 1_000_000) {
  const workers: FakeRunner[] = [];
  const executor = new PythonExecutor(
    () => {
      const w = new FakeRunner();
      workers.push(w);
      return w;
    },
    timeoutMs,
    () => outputBudgetChars
  );
  return { executor, workers };
}

async function initialize(executor: PythonExecutor, workers: FakeRunner[]): Promise<FakeRunner> {
  const ready = executor.initialize();
  const worker = workers.at(-1) as FakeRunner;
  worker.emit({ type: 'ready' });
  await ready;
  return worker;
}

function startRun(executor: PythonExecutor, code = 'x = input()') {
  const out: string[] = [];
  const err: string[] = [];
  let stdin: InteractiveStdin | null = null;
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
  // ターミナル (CTerminal の line discipline) が確定した行と EOF を渡すのを真似る (#707)
  const connected = (): InteractiveStdin => {
    if (!stdin) throw new Error('stdin not ready');
    return stdin;
  };
  const line = (text: string) => connected().writeLine(text);
  const eof = () => connected().close();
  return { promise, out, err, line, eof, result: () => result };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PythonExecutor', () => {
  it('asks the runner to load Pyodide without passing any URL, storage name or credential', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    expect(worker.posted).toEqual([{ type: 'init' }]);
  });

  it('sends only the code, the imported package names and the output budget to the runner', async () => {
    const { executor, workers } = setup(undefined, 1234);
    const worker = await initialize(executor, workers);
    startRun(executor, 'import numpy\nprint(1)\n');
    expect(worker.lastRun()).toEqual({
      type: 'run',
      runId: 1,
      code: 'import numpy\nprint(1)\n',
      packages: ['numpy'],
      outputBudgetChars: 1234,
    });
  });

  it('forwards the line committed by the terminal to the runner without echoing it again', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startRun(executor);
    const { runId } = worker.lastRun();

    worker.emit({ type: 'started', runId });
    worker.emit({ type: 'stdout', runId, text: 'name: ' });
    worker.emit({ type: 'stdin-request', runId, received: 0 });
    run.line('Taro\n');

    // エコーはターミナルがする (#707)。ここで stdout に足すと二重に出る
    expect(run.out.join('')).toBe('name: ');
    expect(worker.stdinRequests()).toEqual([{ type: 'stdin', runId, text: 'Taro\n' }]);

    worker.emit({ type: 'done', runId, success: true, result: null });
    expect(await run.promise).toMatchObject({ success: true, exitCode: 0 });
  });

  it('sends EOF to the runner once the terminal closes stdin and nothing after it (#707)', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startRun(executor);
    const { runId } = worker.lastRun();

    worker.emit({ type: 'started', runId });
    run.line('last\n');
    run.eof();
    run.line('after-eof\n');
    run.eof();

    expect(worker.stdinRequests()).toEqual([
      { type: 'stdin', runId, text: 'last\n' },
      { type: 'stdin-eof', runId },
    ]);
    worker.emit({ type: 'done', runId, success: true, result: null });
    expect(await run.promise).toMatchObject({ success: true });
  });

  it('stops the runner on abort, resolves the run as aborted, and initializes a new runner for the next run', async () => {
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
    worker.emit({ type: 'stdin-request', runId, received: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.result()).toBeNull();
    expect(worker.terminated).toBe(false);

    run.line('ok\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.promise).toMatchObject({ success: false, outcome: 'timeout', timeoutMs: 1_000 });
    expect(worker.terminated).toBe(true);
    expect(executor.isInitialized).toBe(false);
  });

  it('keeps counting time when the input the runner asks for is already on its way', async () => {
    vi.useFakeTimers();
    const { executor, workers } = setup(1_000);
    const worker = await initialize(executor, workers);
    const run = startRun(executor);
    const { runId } = worker.lastRun();

    worker.emit({ type: 'started', runId });
    run.line('typed ahead\n');
    // runner が行を受け取る前に入力を求めた (received 0 < sent 1)。行は届けば渡るので待ちにしない
    worker.emit({ type: 'stdin-request', runId, received: 0 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await run.promise).toMatchObject({ outcome: 'timeout' });
  });

  it('ignores late messages from a stopped runner', async () => {
    const { executor, workers } = setup();
    const first = await initialize(executor, workers);
    const stopped = startRun(executor);
    const oldRunId = first.lastRun().runId;
    executor.abort();
    await stopped.promise;

    // 捨てた runner の ready で、新しい runner の初期化を終えたことにしない
    const init = executor.initialize();
    first.emit({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(executor.isInitialized).toBe(false);
    const second = workers.at(-1) as FakeRunner;
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

  it('fails initialization when the runner reports an error and allows retrying', async () => {
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

  it('fails initialization when the runner itself fails (for example, it is not cross-origin isolated)', async () => {
    const { executor, workers } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const init = executor.initialize();
    workers[0]?.onerror?.('not isolated');
    await expect(init).rejects.toThrow('Failed to initialize Python: not isolated');
    expect(executor.isInitialized).toBe(false);
  });

  it('resolves the run as an error and drops the runner when the runner fails during the run', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startRun(executor, 'print(1)');
    worker.onerror?.('The Python runner crashed: boom');
    expect(await run.promise).toMatchObject({ outcome: 'error', error: 'The Python runner crashed: boom' });
    expect(worker.terminated).toBe(true);
    expect(executor.isInitialized).toBe(false);
  });

  it('cuts the output at the budget, reports it once on stderr and stops the runner as an error', async () => {
    const { executor, workers } = setup(undefined, 10);
    const worker = await initialize(executor, workers);
    const run = startRun(executor, 'print("x" * 100)');
    const { runId } = worker.lastRun();

    worker.emit({ type: 'stdout', runId, text: '123456' });
    worker.emit({ type: 'stderr', runId, text: 'abcdef' });
    worker.emit({ type: 'stdout', runId, text: 'LATE' });

    const result = await run.promise;
    expect(result).toMatchObject({ outcome: 'error', error: 'Output limit exceeded', stdout: '123456' });
    expect(run.err).toEqual(['abcd', outputLimitNotice(10)]);
    expect(run.out).toEqual(['123456']);
    expect(worker.terminated).toBe(true);
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

  it('sends the whole stdin to the runner after the run request and then EOF', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    startBatchRun(executor, '3\n1 8 4\n');
    const { runId } = worker.lastRun();

    expect(worker.posted.slice(1).map((m) => m.type)).toEqual(['run', 'stdin', 'stdin-eof']);
    expect(worker.stdinRequests()).toEqual([
      { type: 'stdin', runId, text: '3\n1 8 4\n' },
      { type: 'stdin-eof', runId },
    ]);
  });

  it('sends only EOF when the given stdin is empty', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    startBatchRun(executor, '');
    expect(worker.stdinRequests()).toEqual([{ type: 'stdin-eof', runId: worker.lastRun().runId }]);
  });

  it('neither connects the terminal nor echoes the given stdin to stdout', async () => {
    const { executor, workers } = setup();
    const worker = await initialize(executor, workers);
    const run = startBatchRun(executor, 'Taro\n');
    const { runId } = worker.lastRun();
    worker.emit({ type: 'stdin-request', runId, received: 2 });
    worker.emit({ type: 'done', runId, success: true, result: null });
    await run.promise;

    expect({ stdinReady: run.stdinReady(), out: run.out.join('') }).toEqual({ stdinReady: false, out: '' });
  });

  it('reports the start of the user program when the runner starts running it', async () => {
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
