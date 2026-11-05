import { describe, expect, it, vi } from 'vitest';
import { awaitTypeScriptWorker, isTypeScriptNotRegistered } from '../awaitTypeScriptWorker.js';

/** 偽の時計: sleep が時計を進める */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe('isTypeScriptNotRegistered', () => {
  it('recognizes the string Monaco rejects with before the TypeScript mode is set up, and the same text in an Error', () => {
    expect(isTypeScriptNotRegistered('TypeScript not registered!')).toBe(true);
    expect(isTypeScriptNotRegistered(new Error('TypeScript not registered!'))).toBe(true);
    expect(isTypeScriptNotRegistered('JavaScript not registered!')).toBe(false);
    expect(isTypeScriptNotRegistered(new Error('Could not create web worker'))).toBe(false);
  });
});

describe('awaitTypeScriptWorker (#624)', () => {
  it('keeps asking while the TypeScript mode is not registered yet and returns the worker once it is', async () => {
    const clock = fakeClock();
    const get = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce('TypeScript not registered!')
      .mockRejectedValueOnce('TypeScript not registered!')
      .mockResolvedValue('worker');

    await expect(awaitTypeScriptWorker(get, { ...clock, intervalMs: 50, timeoutMs: 1_000 })).resolves.toBe('worker');
    expect(get).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(50);
  });

  it('rethrows any other failure at once without waiting', async () => {
    const clock = fakeClock();
    const failure = new Error('Could not create web worker');
    const get = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(awaitTypeScriptWorker(get, { ...clock, timeoutMs: 1_000 })).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('gives up with the not-registered rejection once the time limit has passed', async () => {
    const clock = fakeClock();
    const get = vi.fn<() => Promise<string>>().mockRejectedValue('TypeScript not registered!');

    await expect(awaitTypeScriptWorker(get, { ...clock, intervalMs: 100, timeoutMs: 1_000 })).rejects.toBe(
      'TypeScript not registered!'
    );
    // 0, 100, ..., 1000 の 11 回目で上限に達して投げる
    expect(get).toHaveBeenCalledTimes(11);
  });
});
