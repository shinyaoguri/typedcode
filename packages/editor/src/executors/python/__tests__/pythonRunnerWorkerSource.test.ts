/**
 * Python の runner の Worker のソース (文字列定数) を node の vm で評価して確かめる (#719)。
 *
 * vm のコンテキストを Worker のグローバル (self) に見立て、`importScripts` が偽の `loadPyodide` を
 * 定義する。偽の Pyodide は `runPythonAsync` に渡されたコードを、テストが用意した関数に置き換えて
 * 走らせる (stdout / stderr / stdin の書き手と読み手は本物の Worker のものを使う)。
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { MAX_RUNNER_TEXT_CHARS, OUTPUT_CHUNK_CHARS } from '../pythonRunnerProtocol.js';
import { PYTHON_RUNNER_WORKER_SOURCE } from '../pythonRunnerWorkerSource.js';

type Msg = Record<string, unknown> & { type: string };

interface FakePy {
  write(stream: 'stdout' | 'stderr', text: string): void;
  read(): string;
}

/** 偽の Pyodide。`programs[code]` が利用者のコードの代わりに走る */
function fakePyodide(programs: Record<string, (py: FakePy) => unknown | Promise<unknown>>) {
  let stdout: { write(b: Uint8Array): number } | null = null;
  let stderr: { write(b: Uint8Array): number } | null = null;
  let stdin: { read(b: Uint8Array): number } | null = null;
  const api: FakePy = {
    write: (stream, text) => {
      (stream === 'stdout' ? stdout : stderr)?.write(new TextEncoder().encode(text));
    },
    read: () => {
      const bytes: number[] = [];
      const buf = new Uint8Array(4);
      for (;;) {
        const n = stdin?.read(buf) ?? 0;
        if (n === 0) break;
        bytes.push(...buf.subarray(0, n));
        if (buf[n - 1] === 10) break;
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    },
  };
  return {
    setStdout: (o: { write(b: Uint8Array): number }) => {
      stdout = o;
    },
    setStderr: (o: { write(b: Uint8Array): number }) => {
      stderr = o;
    },
    setStdin: (o: { read(b: Uint8Array): number }) => {
      stdin = o;
    },
    loadPackage: async () => {},
    runPython: () => undefined,
    runPythonAsync: async (code: string) => {
      const program = programs[code];
      if (!program) throw new Error(`no program for ${code}`);
      return program(api);
    },
  };
}

function startWorker(options: {
  programs?: Record<string, (py: FakePy) => unknown | Promise<unknown>>;
  importFails?: boolean;
}) {
  const listeners = new Map<string, (e: unknown) => void>();
  const imported: string[] = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    performance,
    TextDecoder,
    TextEncoder,
    SharedArrayBuffer,
    Int32Array,
    Uint8Array,
    Atomics,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    importScripts: (url: string) => {
      imported.push(url);
      if (options.importFails) throw new Error('script failed to load');
      (context as { loadPyodide?: unknown }).loadPyodide = async () => fakePyodide(options.programs ?? {});
    },
  });
  vm.runInContext('globalThis.self = globalThis;', context);
  vm.runInContext(PYTHON_RUNNER_WORKER_SOURCE, context);

  const messages: Msg[] = [];
  const waiters: { type: string; resolve: (m: Msg) => void }[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(m: Msg) {
      messages.push(m);
      for (const w of waiters.splice(0)) {
        if (w.type === m.type) w.resolve(m);
        else waiters.push(w);
      }
    },
  };
  listeners.get('message')?.({ data: { type: 'connect', port, indexURL: 'https://cdn.example/pyodide/' } });
  const request = (data: Record<string, unknown>) => port.onmessage?.({ data });
  const next = (type: string) =>
    new Promise<Msg>((resolve) => {
      const found = messages.find((m) => m.type === type);
      if (found) resolve(found);
      else waiters.push({ type, resolve });
    });
  const text = (stream: string) =>
    messages
      .filter((m) => m.type === stream)
      .map((m) => m.text as string)
      .join('');
  return { context, messages, imported, request, next, text };
}

async function ready(programs: Record<string, (py: FakePy) => unknown | Promise<unknown>>) {
  const w = startWorker({ programs });
  w.request({ type: 'init' });
  await w.next('ready');
  return w;
}

function run(w: ReturnType<typeof startWorker>, code: string, extra: Record<string, unknown> = {}) {
  const stdinBuffer = new SharedArrayBuffer(8 + 64);
  w.request({ type: 'run', runId: 1, code, packages: [], outputBudgetChars: 1_000_000, stdinBuffer, ...extra });
  return stdinBuffer;
}

describe('Python runner worker', () => {
  it('loads Pyodide from the given index with importScripts and reports progress and ready', async () => {
    const w = await ready({});
    expect(w.imported).toEqual(['https://cdn.example/pyodide/pyodide.js']);
    expect(w.messages.map((m) => m.type)).toEqual(['progress', 'progress', 'progress', 'ready']);
  });

  it('reports init-error when Pyodide cannot be loaded', async () => {
    const w = startWorker({ importFails: true });
    w.request({ type: 'init' });
    expect(await w.next('init-error')).toMatchObject({ error: 'script failed to load' });
  });

  it('keeps the port and other state out of the global scope that Python sees as js', async () => {
    const w = await ready({});
    expect(vm.runInContext('typeof port + typeof send + typeof py', w.context)).toBe('undefinedundefinedundefined');
  });

  it('streams stdout and stderr of a run and ends with done and the value of the last expression', async () => {
    const w = await ready({
      main: (py) => {
        py.write('stdout', 'こんにちは\n');
        py.write('stderr', 'warn\n');
        return 42;
      },
    });
    run(w, 'main');
    expect(await w.next('done')).toEqual({ type: 'done', runId: 1, success: true, result: '42' });
    expect([w.text('stdout'), w.text('stderr')]).toEqual(['こんにちは\n', 'warn\n']);
    expect(w.messages.map((m) => m.type).indexOf('started')).toBeGreaterThan(-1);
  });

  it('sends a large output in chunks no longer than the chunk size', async () => {
    const big = 'x'.repeat(OUTPUT_CHUNK_CHARS * 2 + 10);
    const w = await ready({ main: (py) => py.write('stdout', big) });
    run(w, 'main');
    await w.next('done');
    const chunks = w.messages.filter((m) => m.type === 'stdout').map((m) => (m.text as string).length);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(OUTPUT_CHUNK_CHARS);
    expect(w.text('stdout')).toBe(big);
  });

  it('stops sending output one character past the budget', async () => {
    const w = await ready({
      main: (py) => {
        py.write('stdout', '0123456789');
        py.write('stdout', 'more');
      },
    });
    run(w, 'main', { outputBudgetChars: 5 });
    await w.next('done');
    expect(w.text('stdout')).toBe('012345');
  });

  it('reads the line the runner wrote to the shared stdin buffer', async () => {
    let stdinBuffer: SharedArrayBuffer | null = null;
    const w = await ready({
      main: (py) => {
        py.write('stdout', 'name: ');
        return py.read();
      },
    });
    // runner の書き手を真似る: 入力を求められる前に 1 行を書いておく (Worker は待たずに読む)
    stdinBuffer = run(w, 'main');
    const state = new Int32Array(stdinBuffer, 0, 2);
    new Uint8Array(stdinBuffer, 8).set(new TextEncoder().encode('Taro\n'));
    Atomics.store(state, 1, 5);
    Atomics.store(state, 0, 1);
    expect(await w.next('done')).toMatchObject({ success: true, result: 'Taro\n' });
    expect(w.text('stdout')).toBe('name: ');
  });

  it('truncates a very long error or result to the message limit', async () => {
    const w = await ready({
      main: () => {
        throw new Error('e'.repeat(MAX_RUNNER_TEXT_CHARS + 100));
      },
    });
    run(w, 'main');
    const done = await w.next('done');
    expect(done.success).toBe(false);
    expect((done.error as string).length).toBe(MAX_RUNNER_TEXT_CHARS);
    expect(done.error as string).toMatch(/\(truncated\)$/);
  });
});
