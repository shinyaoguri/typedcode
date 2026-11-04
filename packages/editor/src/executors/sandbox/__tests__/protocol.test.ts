/**
 * sandbox runner から親へのメッセージの形の検査 (#290)。
 * 今の run に宛てた正しい形のものだけを通し、それ以外は捨てる。
 */

import { describe, it, expect } from 'vitest';
import { parseSandboxMessage } from '../protocol.js';

const RUN = 'run-1';

describe('parseSandboxMessage', () => {
  it('accepts each message type addressed to the current run', () => {
    expect(parseSandboxMessage({ type: 'ready', runId: RUN }, RUN)).toEqual({ type: 'ready' });
    expect(parseSandboxMessage({ type: 'stdout', runId: RUN, text: 'a' }, RUN)).toEqual({ type: 'stdout', text: 'a' });
    expect(parseSandboxMessage({ type: 'stderr', runId: RUN, text: 'b' }, RUN)).toEqual({ type: 'stderr', text: 'b' });
    expect(parseSandboxMessage({ type: 'done', runId: RUN, outcome: 'failure', exitCode: 1 }, RUN)).toEqual({
      type: 'done',
      outcome: 'failure',
      exitCode: 1,
    });
    expect(parseSandboxMessage({ type: 'fatal', runId: RUN, message: 'x' }, RUN)).toEqual({
      type: 'fatal',
      message: 'x',
    });
  });

  it('drops messages addressed to another run or without a run id', () => {
    expect(parseSandboxMessage({ type: 'stdout', runId: 'run-0', text: 'late' }, RUN)).toBeNull();
    expect(parseSandboxMessage({ type: 'stdout', text: 'late' }, RUN)).toBeNull();
  });

  it('drops messages whose fields have the wrong type', () => {
    expect(parseSandboxMessage({ type: 'stdout', runId: RUN, text: 42 }, RUN)).toBeNull();
    expect(parseSandboxMessage({ type: 'done', runId: RUN, outcome: 'aborted', exitCode: 0 }, RUN)).toBeNull();
    expect(parseSandboxMessage({ type: 'done', runId: RUN, outcome: 'success', exitCode: '0' }, RUN)).toBeNull();
    expect(parseSandboxMessage({ type: 'fatal', runId: RUN, message: null }, RUN)).toBeNull();
    expect(parseSandboxMessage({ type: 'run', runId: RUN, code: '' }, RUN)).toBeNull();
    expect(parseSandboxMessage('stdout', RUN)).toBeNull();
    expect(parseSandboxMessage(null, RUN)).toBeNull();
  });
});
