/**
 * E2E 用の偽の実行の入口 (#799)。PR ごとの E2E が頼る振る舞い (対応表どおりの結果・中止まで終わらない・呼ばれた順)
 * を固定する。
 */

import { describe, expect, it } from 'vitest';
import { createFakeVerificationRunner } from '../fakeRunner.js';

const request = (filename: string, stdin: string) => ({ language: 'c', filename, code: '', stdin });

describe('createFakeVerificationRunner', () => {
  it('returns the entry matching the filename and stdin', async () => {
    const fake = createFakeVerificationRunner([
      { filename: 'a.c', stdin: '1', stdout: 'one\n' },
      { filename: 'a.c', stdin: '2', outcome: 'timeout' },
    ]);
    expect([await fake.run(request('a.c', '1')), await fake.run(request('a.c', '2'))]).toEqual([
      { stdout: 'one\n', stderr: '', outcome: 'success', exitCode: 0 },
      { stdout: '', stderr: '', outcome: 'timeout', exitCode: null },
    ]);
  });

  it('an entry without stdin applies to any stdin of that file', async () => {
    const fake = createFakeVerificationRunner([{ filename: 'a.c', stdout: 'x' }]);
    expect((await fake.run(request('a.c', 'anything'))).stdout).toBe('x');
  });

  it('reports a call without an entry as a runtime error', async () => {
    const fake = createFakeVerificationRunner([]);
    expect((await fake.run(request('b.c', ''))).outcome).toBe('runtime-error');
  });

  it('a hanging entry ends only when aborted, as aborted', async () => {
    const fake = createFakeVerificationRunner([{ filename: 'a.c', hang: true }]);
    const controller = new AbortController();
    let settled = false;
    const result = fake.run(request('a.c', ''), { signal: controller.signal }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = settled;
    controller.abort();
    expect([before, (await result).outcome]).toEqual([false, 'aborted']);
  });

  it('records the calls in order', async () => {
    const fake = createFakeVerificationRunner([{ filename: 'a.c' }]);
    await fake.run(request('a.c', '1'));
    await fake.run(request('a.c', '2'));
    expect(fake.calls()).toEqual([
      { filename: 'a.c', stdin: '1' },
      { filename: 'a.c', stdin: '2' },
    ]);
  });
});
