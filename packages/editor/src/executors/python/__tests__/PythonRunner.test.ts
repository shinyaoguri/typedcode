/**
 * Python の runner の親の側 (#719)。iframe と window を偽の host に差し替え、
 * 受け取るメッセージの検査 (source / origin / runnerId)、準備応答までの待ち、fail closed を確かめる。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NOT_ISOLATED_ERROR,
  RUNNER_NOT_STARTED_ERROR,
  createPythonRunner,
  type PythonRunnerHost,
  type PythonRunnerMessageEvent,
} from '../PythonRunner.js';
import type { PythonExecMessage } from '../pythonRunnerProtocol.js';

const RUNNER_ID = 'runner-1';
const PARENT = 'https://typedcode.example';

function fakeHost() {
  const contentWindow = { posted: [] as { message: unknown; target: string }[] };
  const target = {
    postMessage(message: unknown, targetOrigin: string) {
      contentWindow.posted.push({ message, target: targetOrigin });
    },
  };
  const listeners = new Set<(e: PythonRunnerMessageEvent) => void>();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const state = { srcdoc: '', removed: false };
  const host: PythonRunnerHost = {
    parentOrigin: PARENT,
    createFrame(srcdoc) {
      state.srcdoc = srcdoc;
      return {
        contentWindow: target,
        remove: () => {
          state.removed = true;
        },
      };
    },
    addMessageListener: (l) => listeners.add(l),
    removeMessageListener: (l) => listeners.delete(l),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const deliver = (data: unknown, opts: { source?: unknown; origin?: string } = {}) => {
    for (const l of [...listeners]) l({ source: opts.source ?? target, origin: opts.origin ?? 'null', data });
  };
  const fireTimers = () => {
    // 実物のタイマーと同じく、短いものから発火する
    for (const t of timers.splice(0).sort((a, b) => a.ms - b.ms)) if (!t.cleared) t.fn();
  };
  return { host, posted: contentWindow.posted, listeners, state, deliver, fireTimers };
}

function setup() {
  const fake = fakeHost();
  const runner = createPythonRunner({ host: fake.host, readyTimeoutMs: 1_000, createRunnerId: () => RUNNER_ID });
  const messages: PythonExecMessage[] = [];
  const errors: string[] = [];
  runner.onmessage = (m) => messages.push(m);
  runner.onerror = (e) => errors.push(e);
  const ready = (crossOriginIsolated = true) =>
    fake.deliver({ type: 'runner-ready', runnerId: RUNNER_ID, crossOriginIsolated });
  return { ...fake, runner, messages, errors, ready };
}

describe('createPythonRunner', () => {
  it('embeds the runner ID and the parent origin in the runner document', () => {
    const { state } = setup();
    expect(state.srcdoc).toContain(JSON.stringify(RUNNER_ID));
    expect(state.srcdoc).toContain(JSON.stringify(PARENT));
  });

  it('holds requests until the runner is ready and then sends them with the runner ID', () => {
    const { runner, posted, ready } = setup();
    runner.postMessage({ type: 'init' });
    expect(posted).toEqual([]);
    ready();
    expect(posted).toEqual([{ message: { type: 'init', runnerId: RUNNER_ID }, target: '*' }]);
  });

  it('passes on a checked message from the runner frame', () => {
    const { messages, deliver, ready } = setup();
    ready();
    deliver({ type: 'stdout', runnerId: RUNNER_ID, runId: 1, text: 'hi' });
    expect(messages).toEqual([{ type: 'stdout', runId: 1, text: 'hi' }]);
  });

  it('ignores messages from another source, a non-opaque origin, another runner or of a bad shape', () => {
    const { messages, deliver, ready } = setup();
    ready();
    const ok = { type: 'stdout', runnerId: RUNNER_ID, runId: 1, text: 'x' };
    deliver(ok, { source: {} });
    deliver(ok, { origin: PARENT });
    deliver({ ...ok, runnerId: 'runner-2' });
    deliver({ ...ok, text: 1 });
    deliver({ ...ok, type: 'eval' });
    expect(messages).toEqual([]);
  });

  it('ignores runner messages that arrive before the runner says it is ready', () => {
    const { messages, deliver } = setup();
    deliver({ type: 'ready', runnerId: RUNNER_ID });
    expect(messages).toEqual([]);
  });

  it('fails closed when the runner is not cross-origin isolated: removes the frame and sends nothing', () => {
    const { runner, posted, errors, state, listeners, ready } = setup();
    runner.postMessage({ type: 'init' });
    ready(false);
    expect(errors).toEqual([NOT_ISOLATED_ERROR]);
    expect(state.removed).toBe(true);
    expect(listeners.size).toBe(0);
    runner.postMessage({ type: 'init' });
    expect(posted).toEqual([]);
  });

  it('fails when the runner does not become ready in time', () => {
    const { errors, state, fireTimers } = setup();
    fireTimers();
    expect(errors).toEqual([RUNNER_NOT_STARTED_ERROR]);
    expect(state.removed).toBe(true);
  });

  it('does not fail on the ready timer once the runner is ready', () => {
    const { errors, fireTimers, ready } = setup();
    ready();
    fireTimers();
    expect(errors).toEqual([]);
  });

  it('reports a fatal message from the runner as an error and stops the runner', () => {
    const { errors, state, deliver, ready } = setup();
    ready();
    deliver({ type: 'fatal', runnerId: RUNNER_ID, message: 'The Python runner crashed: x' });
    expect(errors).toEqual(['The Python runner crashed: x']);
    expect(state.removed).toBe(true);
  });

  it('removes the frame and stops listening on terminate without reporting an error', () => {
    const { runner, errors, state, listeners, messages, deliver, ready } = setup();
    ready();
    runner.terminate();
    deliver({ type: 'ready', runnerId: RUNNER_ID });
    expect({ removed: state.removed, listeners: listeners.size, errors, messages }).toEqual({
      removed: true,
      listeners: 0,
      errors: [],
      messages: [],
    });
  });

  it('reports a failure to create the frame on the next tick, after the caller attached onerror', () => {
    const fake = fakeHost();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createPythonRunner({
      host: {
        ...fake.host,
        createFrame: () => {
          throw new Error('no document');
        },
      },
      createRunnerId: () => RUNNER_ID,
      readyTimeoutMs: 1_000,
    });
    const errors: string[] = [];
    runner.onerror = (e) => errors.push(e);
    fake.fireTimers();
    expect(errors[0]).toBe('Failed to create the Python runner: no document');
  });
});
