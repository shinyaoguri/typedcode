/**
 * Python の runner の srcdoc (#719)。CSP・sandbox の属性と、runner の inline script の振る舞い
 * (受け取りの検査・fail closed・中継・stdin の受け渡し) を確かめる。inline script は node の vm で
 * 評価し、window・Worker・MessageChannel を偽物にする。
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  PYTHON_RUNNER_CSP,
  PYTHON_RUNNER_IFRAME_ALLOW,
  PYTHON_RUNNER_IFRAME_TOKENS,
  buildPythonRunnerSrcdoc,
} from '../pythonRunnerDocument.js';
import { PYODIDE_CDN_URL } from '../pythonRunnerProtocol.js';

const RUNNER_ID = 'runner-1';
const PARENT = 'https://typedcode.example';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name as string, values];
    })
  );
}

describe('Python runner document', () => {
  it('grants only allow-scripts to the iframe (an opaque origin) and asks for cross-origin isolation', () => {
    expect(PYTHON_RUNNER_IFRAME_TOKENS.split(/\s+/)).toEqual(['allow-scripts']);
    expect(PYTHON_RUNNER_IFRAME_ALLOW).toBe('cross-origin-isolated');
  });

  it('declares a CSP without eval that loads scripts only from the Pyodide index and connects only to it and PyPI', () => {
    const csp = directives(PYTHON_RUNNER_CSP);
    expect(csp.get('default-src')).toEqual(["'none'"]);
    expect(csp.get('script-src')).toEqual(["'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:', PYODIDE_CDN_URL]);
    expect(csp.get('worker-src')).toEqual(['blob:']);
    expect(csp.get('connect-src')).toEqual([PYODIDE_CDN_URL, 'https://pypi.org', 'https://files.pythonhosted.org']);
    expect(PYTHON_RUNNER_CSP).not.toContain("'unsafe-eval'");
  });

  it('puts the CSP in the document and keeps a single inline script whatever the embedded strings contain', () => {
    const doc = buildPythonRunnerSrcdoc({
      runnerId: '</script><script>alert(1)</script>',
      parentOrigin: PARENT,
      workerSource: 'void "</script>"',
    });
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${PYTHON_RUNNER_CSP}">`);
    expect(doc.match(/<script>/g)).toHaveLength(1);
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
  });
});

interface Posted {
  message: Record<string, unknown>;
  target: string;
}

/** runner の inline script を偽の window で動かす */
function startRunner(opts: { isolated?: boolean } = {}) {
  const doc = buildPythonRunnerSrcdoc({ runnerId: RUNNER_ID, parentOrigin: PARENT, workerSource: 'WORKER' });
  const script = /<script>([\s\S]*)<\/script>/.exec(doc)?.[1] as string;
  const toParent: Posted[] = [];
  const toWorker: Record<string, unknown>[] = [];
  const workers: { source: string; posted: Record<string, unknown>[] }[] = [];
  let parentListener: ((e: { source: unknown; origin: string; data: unknown }) => void) | null = null;
  const parentWindow = {
    postMessage: (message: Record<string, unknown>, target: string) => toParent.push({ message, target }),
  };
  const port1: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: Record<string, unknown>): void } = {
    onmessage: null,
    postMessage: (m) => toWorker.push(m),
  };
  class FakeWorker {
    posted: Record<string, unknown>[] = [];
    onerror: unknown = null;
    constructor(public url: string) {
      workers.push({ source: blobs.get(url) as string, posted: this.posted });
    }
    postMessage(m: Record<string, unknown>) {
      this.posted.push(m);
    }
  }
  const blobs = new Map<string, string>();
  const context = vm.createContext({
    crossOriginIsolated: opts.isolated ?? true,
    parent: parentWindow,
    addEventListener: (type: string, fn: typeof parentListener) => {
      if (type === 'message') parentListener = fn;
    },
    Blob: class {
      constructor(public parts: string[]) {}
    },
    URL: {
      createObjectURL: (blob: { parts: string[] }) => {
        const url = `blob:${blobs.size}`;
        blobs.set(url, blob.parts.join(''));
        return url;
      },
    },
    Worker: FakeWorker,
    MessageChannel: class {
      port1 = port1;
      port2 = { name: 'port2' };
    },
    SharedArrayBuffer: opts.isolated === false ? undefined : SharedArrayBuffer,
    Int32Array,
    Uint8Array,
    Atomics,
    TextEncoder,
  });
  vm.runInContext('globalThis.self = globalThis;', context);
  vm.runInContext(script, context);

  const fromParent = (data: Record<string, unknown>, e: { source?: unknown; origin?: string } = {}) =>
    parentListener?.({
      source: e.source ?? parentWindow,
      origin: e.origin ?? PARENT,
      data: { runnerId: RUNNER_ID, ...data },
    });
  const fromWorker = (data: Record<string, unknown>) => port1.onmessage?.({ data });
  return { toParent, toWorker, workers, fromParent, fromWorker };
}

describe('Python runner script', () => {
  it('starts the worker from the given source, connects it with a port and says it is ready', () => {
    const r = startRunner();
    expect(r.workers.map((w) => w.source)).toEqual(['WORKER']);
    expect(r.workers[0]?.posted[0]).toMatchObject({ type: 'connect', indexURL: PYODIDE_CDN_URL });
    expect(r.toParent).toEqual([
      { message: { type: 'runner-ready', crossOriginIsolated: true, runnerId: RUNNER_ID }, target: PARENT },
    ]);
  });

  it('fails closed without cross-origin isolation: starts no worker and reports that it is not isolated', () => {
    const r = startRunner({ isolated: false });
    expect(r.workers).toEqual([]);
    expect(r.toParent.map((p) => p.message)).toEqual([
      { type: 'runner-ready', crossOriginIsolated: false, runnerId: RUNNER_ID },
    ]);
    r.fromParent({ type: 'init' });
    expect(r.toWorker).toEqual([]);
  });

  it('accepts a request only from the parent window, from the parent origin and for this runner', () => {
    const r = startRunner();
    r.fromParent({ type: 'init' }, { source: {} });
    r.fromParent({ type: 'init' }, { origin: 'https://evil.example' });
    r.fromParent({ type: 'init', runnerId: 'runner-2' });
    r.fromParent({ type: 'eval', code: '1' });
    expect(r.toWorker).toEqual([]);
    r.fromParent({ type: 'init' });
    expect(r.toWorker).toEqual([{ type: 'init' }]);
  });

  it('starts a run with a fresh stdin buffer shared with the worker and rejects a malformed run', () => {
    const r = startRunner();
    r.fromParent({ type: 'run', runId: 1, code: 1, packages: [], outputBudgetChars: 10 });
    r.fromParent({ type: 'run', runId: 1, code: 'x', packages: [1], outputBudgetChars: 10 });
    expect(r.toWorker).toEqual([]);
    r.fromParent({ type: 'run', runId: 1, code: 'print(1)', packages: ['numpy'], outputBudgetChars: 10 });
    expect(r.toWorker).toEqual([
      {
        type: 'run',
        runId: 1,
        code: 'print(1)',
        packages: ['numpy'],
        outputBudgetChars: 10,
        stdinBuffer: expect.any(SharedArrayBuffer),
      },
    ]);
  });

  it('relays worker messages to the parent origin with the runner ID', () => {
    const r = startRunner();
    r.fromWorker({ type: 'stdout', runId: 1, text: 'hi' });
    expect(r.toParent.at(-1)).toEqual({
      message: { type: 'stdout', runId: 1, text: 'hi', runnerId: RUNNER_ID },
      target: PARENT,
    });
  });

  it('hands buffered input to the waiting worker itself and asks the parent only when it has none', () => {
    const r = startRunner();
    r.fromParent({ type: 'run', runId: 1, code: 'input()', packages: [], outputBudgetChars: 10 });
    const sab = r.toWorker[0]?.stdinBuffer as SharedArrayBuffer;
    const state = new Int32Array(sab, 0, 2);

    r.fromParent({ type: 'stdin', runId: 1, text: 'あ\n' });
    expect(Atomics.load(state, 0)).toBe(1);
    expect(new TextDecoder().decode(new Uint8Array(sab, 8, Atomics.load(state, 1)))).toBe('あ\n');
    Atomics.store(state, 0, 0); // Worker が読んだ

    const before = r.toParent.length;
    r.fromWorker({ type: 'stdin-request', runId: 1 });
    expect(r.toParent.slice(before).map((p) => p.message)).toEqual([
      { type: 'stdin-request', runId: 1, received: 1, runnerId: RUNNER_ID },
    ]);
  });

  it('writes EOF as an empty chunk once the parent closes stdin, and ignores stdin of another run', () => {
    const r = startRunner();
    r.fromParent({ type: 'run', runId: 2, code: 'input()', packages: [], outputBudgetChars: 10 });
    const sab = r.toWorker[0]?.stdinBuffer as SharedArrayBuffer;
    const state = new Int32Array(sab, 0, 2);
    r.fromParent({ type: 'stdin', runId: 1, text: 'old\n' });
    expect(Atomics.load(state, 0)).toBe(0);
    r.fromParent({ type: 'stdin-eof', runId: 2 });
    expect([Atomics.load(state, 0), Atomics.load(state, 1)]).toEqual([1, 0]);
  });
});
