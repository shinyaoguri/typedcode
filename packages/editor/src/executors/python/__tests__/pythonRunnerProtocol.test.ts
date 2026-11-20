/**
 * Python の runner から親へのメッセージの検査 (#719)。runner は opaque origin の別 realm なので、
 * 親は受け取ったものを信用せず、この関数を通ったものだけを扱う。
 */

import { describe, it, expect } from 'vitest';
import { MAX_RUNNER_TEXT_CHARS, parsePythonRunnerMessage } from '../pythonRunnerProtocol.js';

const ID = 'runner-1';
const parse = (data: unknown) => parsePythonRunnerMessage(data, ID);

describe('parsePythonRunnerMessage', () => {
  it('accepts every message type of this runner in its documented shape', () => {
    const valid: Record<string, unknown>[] = [
      { type: 'runner-ready', crossOriginIsolated: true },
      { type: 'fatal', message: 'boom' },
      { type: 'progress', stage: 'sdk', message: 'loading', percentage: 20 },
      { type: 'progress', stage: 'ready', message: 'ready' },
      { type: 'ready' },
      { type: 'init-error', error: 'network' },
      { type: 'run-progress', runId: 1, message: 'Installing' },
      { type: 'stdout', runId: 1, text: 'a' },
      { type: 'stderr', runId: 1, text: 'b' },
      { type: 'started', runId: 1 },
      { type: 'stdin-request', runId: 1, received: 0 },
      { type: 'done', runId: 1, success: true, result: null },
      { type: 'done', runId: 1, success: false, error: 'ValueError', result: '1' },
    ];
    expect(valid.map((m) => parse({ ...m, runnerId: ID }))).toEqual(valid);
  });

  it('drops a message addressed from another runner or without a runner ID', () => {
    expect(parse({ type: 'ready', runnerId: 'runner-2' })).toBeNull();
    expect(parse({ type: 'ready' })).toBeNull();
  });

  it('drops an unknown type and anything that is not an object', () => {
    expect(parse({ type: 'eval', runnerId: ID, code: '1' })).toBeNull();
    expect(parse('ready')).toBeNull();
    expect(parse(null)).toBeNull();
  });

  it('drops a message whose fields have the wrong type', () => {
    expect(parse({ type: 'runner-ready', runnerId: ID, crossOriginIsolated: 'true' })).toBeNull();
    expect(parse({ type: 'stdout', runnerId: ID, runId: '1', text: 'a' })).toBeNull();
    expect(parse({ type: 'stdout', runnerId: ID, runId: 0, text: 'a' })).toBeNull();
    expect(parse({ type: 'stdin-request', runnerId: ID, runId: 1, received: -1 })).toBeNull();
    expect(parse({ type: 'done', runnerId: ID, runId: 1, success: 'yes', result: null })).toBeNull();
    expect(parse({ type: 'done', runnerId: ID, runId: 1, success: true, result: 42 })).toBeNull();
    expect(parse({ type: 'progress', runnerId: ID, stage: 'other', message: 'x' })).toBeNull();
  });

  it('drops a text longer than the limit and accepts one exactly at the limit', () => {
    const atLimit = 'x'.repeat(MAX_RUNNER_TEXT_CHARS);
    expect(parse({ type: 'stdout', runnerId: ID, runId: 1, text: atLimit })).not.toBeNull();
    expect(parse({ type: 'stdout', runnerId: ID, runId: 1, text: `${atLimit}x` })).toBeNull();
    expect(
      parse({ type: 'done', runnerId: ID, runId: 1, success: false, error: `${atLimit}x`, result: null })
    ).toBeNull();
  });

  it('copies only the known fields so that extra fields never reach the executor', () => {
    expect(parse({ type: 'started', runnerId: ID, runId: 1, extra: { proof: true } })).toEqual({
      type: 'started',
      runId: 1,
    });
  });
});
