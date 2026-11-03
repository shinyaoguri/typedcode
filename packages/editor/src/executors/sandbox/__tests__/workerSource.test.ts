/**
 * sandbox の Worker スクリプト (文字列定数) を node の vm で評価して確かめる (#290)。
 *
 * ブラウザの Worker の代わりに、vm のコンテキストを Worker のグローバル (self) に見立てる。
 * 起動メッセージで渡す MessagePort は偽物で、送られたメッセージを記録する。タイマーは node の実物。
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { SANDBOX_WORKER_SOURCE } from '../workerSource.js';

type PortMessage = { type: 'stdout' | 'stderr'; text: string } | { type: 'done'; outcome: string; exitCode: number };

interface WorkerHarness {
  messages: PortMessage[];
  done: Promise<PortMessage>;
  /** Worker のグローバルに張られたリスナーへ合成イベントを送る (unhandledrejection など) */
  dispatch(type: string, event: Record<string, unknown>): void;
  stdout(): string;
  stderr(): string;
}

function startWorker(code: string, outputBudgetChars = 1_000_000): WorkerHarness {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
  });
  vm.runInContext('globalThis.self = globalThis;', context);
  vm.runInContext(SANDBOX_WORKER_SOURCE, context);

  const messages: PortMessage[] = [];
  let resolveDone!: (m: PortMessage) => void;
  const done = new Promise<PortMessage>((resolve) => {
    resolveDone = resolve;
  });
  const port = {
    postMessage(msg: PortMessage) {
      messages.push(msg);
      if (msg.type === 'done') resolveDone(msg);
    },
  };
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault: () => {}, ...event });
  };
  dispatch('message', { data: { code, outputBudgetChars, port } });
  const text = (stream: 'stdout' | 'stderr') =>
    messages
      .filter((m): m is { type: 'stdout' | 'stderr'; text: string } => m.type === stream)
      .map((m) => m.text)
      .join('');
  return { messages, done, dispatch, stdout: () => text('stdout'), stderr: () => text('stderr') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sandbox worker: console', () => {
  it('formats console output the same way as the previous in-page console proxy', async () => {
    const w = startWorker(
      [
        'console.log("a", 1, true, null, undefined);',
        'console.log({ x: 1 }, [1, 2], function named() {});',
        'console.info("i"); console.debug("d");',
        'console.warn("w"); console.error("e");',
        'console.log(new RangeError("bad"));',
        'console.count(); console.count();',
        'console.assert(false, "nope");',
      ].join('\n')
    );
    await w.done;
    expect(w.stdout()).toBe(
      'a 1 true null undefined\n{"x":1} [1,2] [Function: named]\n[INFO] i\n[DEBUG] d\nRangeError: bad\ndefault: 1\ndefault: 2\n'
    );
    expect(w.stderr()).toBe('[WARN] w\n[ERROR] e\nAssertion failed: nope\n');
  });

  it('prints the value returned by top-level code', async () => {
    const w = startWorker('await null;\nreturn 1 + 2;');
    await expect(w.done).resolves.toEqual({ type: 'done', outcome: 'success', exitCode: 0 });
    expect(w.stdout()).toBe('=> 3\n');
  });

  it('runs user code in strict mode', async () => {
    const w = startWorker('undeclared = 1;');
    await expect(w.done).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
    expect(w.stderr()).toMatch(/^ReferenceError: undeclared is not defined/);
  });
});

describe('sandbox worker: completion', () => {
  it('waits for pending timers before reporting completion, like Node', async () => {
    const w = startWorker('setTimeout(() => console.log("later"), 30);\nconsole.log("now");');
    await expect(w.done).resolves.toMatchObject({ outcome: 'success' });
    expect(w.stdout()).toBe('now\nlater\n');
  });

  it('completes once an interval is cleared, and not while it keeps running', async () => {
    const forever = startWorker('setInterval(() => {}, 5);');
    await sleep(80);
    expect(forever.messages.some((m) => m.type === 'done')).toBe(false);

    const cleared = startWorker('let n = 0;\nconst id = setInterval(() => { if (++n === 3) clearInterval(id); }, 5);');
    await expect(cleared.done).resolves.toMatchObject({ outcome: 'success' });
  });

  it('completes when a timeout is cleared before it fires', async () => {
    const w = startWorker('const id = setTimeout(() => console.log("never"), 10_000);\nclearTimeout(id);');
    await expect(w.done).resolves.toMatchObject({ outcome: 'success' });
    expect(w.stdout()).toBe('');
  });

  it('fails as soon as a timer callback throws, even with other timers pending', async () => {
    const w = startWorker('setTimeout(() => { throw new TypeError("in timer"); }, 5);\nsetTimeout(() => {}, 10_000);');
    await expect(w.done).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
    expect(w.stderr()).toMatch(/^TypeError: in timer/);
  });

  it('fails on an unhandled promise rejection', async () => {
    const w = startWorker('setTimeout(() => {}, 10_000);');
    await sleep(20);
    w.dispatch('unhandledrejection', { reason: new Error('nobody caught me') });
    await expect(w.done).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
    expect(w.stderr()).toContain('Error: nobody caught me');
  });

  it('reports a syntax error as a failure', async () => {
    const w = startWorker('const = ;');
    await expect(w.done).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
    expect(w.stderr()).toMatch(/^SyntaxError/);
  });
});

describe('sandbox worker: error location', () => {
  it('reports a thrown error at the user line and column where it happened', async () => {
    const w = startWorker('const a = 1;\nconst b = 2;\nnull.x;');
    await w.done;
    expect(w.stderr()).toMatch(/\(at line 3, column 6\)\n$/);
  });

  it('reports an error thrown inside a timer callback at its user line', async () => {
    const w = startWorker('setTimeout(() => {\n  null.y;\n}, 1);');
    await w.done;
    expect(w.stderr()).toMatch(/\(at line 2, column 8\)\n$/);
  });
});

describe('sandbox worker: output budget', () => {
  it('stops sending output one character past the budget', async () => {
    const w = startWorker('for (let i = 0; i < 1000; i++) console.log("0123456789");', 25);
    await w.done;
    expect(w.stdout() + w.stderr()).toHaveLength(26);
  });
});
