/**
 * SandboxRunner (親側) のテスト (#290)。
 *
 * iframe と window の代わりに偽の host を渡し、runner からのメッセージを手で流す。
 * 時間は host の setTimeout を手で進める (実時間を待たない)。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  outputLimitNotice,
  SandboxRunner,
  type SandboxCallbacks,
  type SandboxHost,
  type SandboxMessageEventLike,
} from '../SandboxRunner.js';
import type { ExecutionLimits } from '../limits.js';

class FakeHost implements SandboxHost {
  listeners = new Set<(e: SandboxMessageEventLike) => void>();
  timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;
  private nextTimer = 1;
  frames: {
    srcdoc: string;
    removed: boolean;
    posted: unknown[];
    contentWindow: { postMessage: (m: unknown) => void };
  }[] = [];
  failCreate = false;

  createFrame(srcdoc: string) {
    if (this.failCreate) throw new Error('no document');
    const frame = {
      srcdoc,
      removed: false,
      posted: [] as unknown[],
      contentWindow: { postMessage: (m: unknown) => frame.posted.push(m) },
      remove: () => {
        frame.removed = true;
      },
    };
    this.frames.push(frame);
    return frame;
  }
  addMessageListener(l: (e: SandboxMessageEventLike) => void) {
    this.listeners.add(l);
  }
  removeMessageListener(l: (e: SandboxMessageEventLike) => void) {
    this.listeners.delete(l);
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextTimer++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }
  /** 最後に作った iframe から runner のメッセージを送る */
  fromFrame(data: Record<string, unknown>, index = this.frames.length - 1) {
    const source = this.frames[index]?.contentWindow;
    for (const l of [...this.listeners]) l({ source, data: { runId: 'run-1', ...data } });
  }
}

const LIMITS: ExecutionLimits = { timeoutMs: 1000, outputBudgetChars: 10, readyTimeoutMs: 100 };

function setup(limits: ExecutionLimits = LIMITS) {
  const host = new FakeHost();
  const runner = new SandboxRunner({ host, limits: () => limits, createRunId: () => 'run-1' });
  const out: string[] = [];
  const err: string[] = [];
  const callbacks: SandboxCallbacks = { onStdout: (t) => out.push(t), onStderr: (t) => err.push(t) };
  const run = runner.start('console.log(1)', callbacks);
  return { host, run, out, err };
}

describe('SandboxRunner', () => {
  it('sends the code to the runner once it is ready and reports the outcome it completes with', async () => {
    const { host, run, out } = setup();
    expect(host.frames[0]?.posted).toEqual([]);
    host.fromFrame({ type: 'ready' });
    expect(host.frames[0]?.posted).toEqual([
      { type: 'run', runId: 'run-1', code: 'console.log(1)', outputBudgetChars: 10 },
    ]);
    host.fromFrame({ type: 'stdout', text: '1\n' });
    host.fromFrame({ type: 'done', outcome: 'success', exitCode: 0 });
    await expect(run.result).resolves.toMatchObject({ outcome: 'success', exitCode: 0, stdout: '1\n' });
    expect(out).toEqual(['1\n']);
    expect(host.frames[0]?.removed).toBe(true);
    expect(host.listeners.size).toBe(0);
  });

  it('ignores messages from a window other than its own runner frame', async () => {
    const { host, run, out } = setup();
    host.fromFrame({ type: 'ready' });
    for (const l of host.listeners) l({ source: {}, data: { runId: 'run-1', type: 'stdout', text: 'spoof' } });
    for (const l of host.listeners)
      l({ source: {}, data: { runId: 'run-1', type: 'done', outcome: 'success', exitCode: 0 } });
    expect(out).toEqual([]);
    run.abort();
    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted' });
  });

  it('ignores output that arrives before the runner reported ready', async () => {
    const { host, run, out } = setup();
    host.fromFrame({ type: 'stdout', text: 'early' });
    host.fromFrame({ type: 'done', outcome: 'success', exitCode: 0 });
    expect(out).toEqual([]);
    run.abort();
    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted', stdout: '' });
  });

  it('removes the frame on abort and drops anything the runner sends afterwards', async () => {
    const { host, run, out } = setup();
    host.fromFrame({ type: 'ready' });
    run.abort();
    host.fromFrame({ type: 'stdout', text: 'LATE' });
    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted', exitCode: null });
    expect(out).toEqual([]);
    expect(host.frames[0]?.removed).toBe(true);
    expect(host.timers.size).toBe(0);
  });

  it('ends with timeout when the run exceeds the time limit', async () => {
    const { host, run } = setup();
    host.fromFrame({ type: 'ready' });
    host.advance(999);
    host.advance(1);
    await expect(run.result).resolves.toMatchObject({ outcome: 'timeout', exitCode: null });
    expect(host.frames[0]?.removed).toBe(true);
  });

  it('cuts output at the budget, notifies once on stderr and ends with error', async () => {
    const { host, run, out, err } = setup();
    host.fromFrame({ type: 'ready' });
    host.fromFrame({ type: 'stdout', text: '1234567' });
    host.fromFrame({ type: 'stderr', text: 'abcdef' });
    host.fromFrame({ type: 'stdout', text: 'more' });
    const result = await run.result;
    expect(result).toMatchObject({ outcome: 'error', exitCode: null, error: 'Output limit exceeded' });
    expect(out).toEqual(['1234567']);
    expect(err).toEqual(['abc', outputLimitNotice(10)]);
    expect(host.frames[0]?.removed).toBe(true);
  });

  it('ends with error when the runner never reports ready', async () => {
    const { host, run, err } = setup();
    host.advance(100);
    await expect(run.result).resolves.toMatchObject({ outcome: 'error', exitCode: null });
    expect(err.join('')).toContain('did not start');
    expect(host.frames[0]?.removed).toBe(true);
  });

  it('ends with error when the frame cannot be created', async () => {
    const host = new FakeHost();
    host.failCreate = true;
    const runner = new SandboxRunner({ host, limits: () => LIMITS, createRunId: () => 'run-1' });
    const onStderr = vi.fn();
    const result = await runner.start('1', { onStdout: () => {}, onStderr }).result;
    expect(result.outcome).toBe('error');
    expect(onStderr).toHaveBeenCalledWith(expect.stringContaining('no document'));
    expect(host.listeners.size).toBe(0);
    expect(host.timers.size).toBe(0);
  });

  it('ends with error when the runner reports that the worker crashed', async () => {
    const { host, run } = setup();
    host.fromFrame({ type: 'ready' });
    host.fromFrame({ type: 'fatal', message: 'The code runner crashed: boom' });
    await expect(run.result).resolves.toMatchObject({ outcome: 'error', error: 'The code runner crashed: boom' });
  });

  it('keeps cleaning up when the output callback throws', async () => {
    const host = new FakeHost();
    const runner = new SandboxRunner({ host, limits: () => LIMITS, createRunId: () => 'run-1' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = runner.start('1', {
      onStdout: () => {
        throw new Error('terminal gone');
      },
      onStderr: () => {},
    });
    host.fromFrame({ type: 'ready' });
    host.fromFrame({ type: 'stdout', text: 'x' });
    host.fromFrame({ type: 'done', outcome: 'failure', exitCode: 1 });
    await expect(run.result).resolves.toMatchObject({ outcome: 'failure', exitCode: 1 });
    spy.mockRestore();
  });
});
