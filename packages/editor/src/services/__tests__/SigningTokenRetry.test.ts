/**
 * 署名専用 token の再取得 (#236): 同時 1 本・ジッタ付き指数バックオフ・上限 5 分・online で早める。
 * 教室の端末が同時に online へ戻っても取得をバーストさせないことを fake timers と固定の乱数で確かめる。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SigningTokenRetry, signingTokenBackoffMs } from '../SigningTokenRetry.js';
import {
  SIGNING_TOKEN_ONLINE_JITTER_MS,
  SIGNING_TOKEN_RETRY_BASE_MS,
  SIGNING_TOKEN_RETRY_MAX_MS,
} from '../../config/timeouts.js';

/** 決着を手で制御できる取得のスタブ */
function controllableAcquire() {
  const pending: Array<(ok: boolean) => void> = [];
  const acquire = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        pending.push(resolve);
      })
  );
  return {
    acquire,
    /** 直近に始まった取得を決着させる */
    settle: async (ok: boolean) => {
      pending.shift()?.(ok);
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** 再現可能な一様乱数 (線形合同法) */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('signingTokenBackoffMs (#236)', () => {
  it('doubles the ceiling per failure and keeps the wait within [ceiling/2, ceiling]', () => {
    for (const [failures, ceiling] of [
      [1, SIGNING_TOKEN_RETRY_BASE_MS],
      [2, SIGNING_TOKEN_RETRY_BASE_MS * 2],
      [3, SIGNING_TOKEN_RETRY_BASE_MS * 4],
    ] as const) {
      expect(signingTokenBackoffMs(failures, () => 0)).toBe(ceiling / 2);
      expect(signingTokenBackoffMs(failures, () => 0.999_999)).toBeLessThanOrEqual(ceiling);
      expect(signingTokenBackoffMs(failures, () => 0.999_999)).toBeGreaterThan(ceiling * 0.99);
    }
  });

  it('never waits longer than the 5-minute cap however many attempts failed', () => {
    expect(SIGNING_TOKEN_RETRY_MAX_MS).toBe(300_000);
    for (const failures of [7, 8, 20, 1_000]) {
      expect(signingTokenBackoffMs(failures, () => 0.999_999)).toBeLessThanOrEqual(SIGNING_TOKEN_RETRY_MAX_MS);
      expect(signingTokenBackoffMs(failures, () => 0)).toBe(SIGNING_TOKEN_RETRY_MAX_MS / 2);
    }
  });
});

describe('SigningTokenRetry (#236)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most one acquisition at a time however often a token is requested', async () => {
    const { acquire, settle } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0.5 });

    retry.request();
    retry.request();
    retry.track(Promise.resolve(true));
    retry.notifyOnline();
    await flushMicrotasks();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(retry.state).toBe('in-flight');
    await settle(true);
  });

  it('retries a failed acquisition only after the backoff delay has elapsed', async () => {
    const { acquire, settle } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0 });

    retry.request();
    await settle(false);
    // 失敗 1 回目の後は base/2 (random=0)。その手前では試さず、request() でもバックオフを飛ばさない
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS / 2 - 1);
    retry.request();
    expect(acquire).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(2);

    await settle(false);
    // 失敗 2 回目の後は base (= 2·base / 2)
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS - 1);
    expect(acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(3);
    retry.dispose();
  });

  it('stops retrying once a token has been acquired', async () => {
    const { acquire, settle } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0.5 });

    retry.request();
    await settle(false);
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS);
    await settle(true);
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS * 10);

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(retry.state).toBe('idle');
  });

  it('treats a rejected acquisition as a failure and keeps retrying', async () => {
    const acquire = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true);
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0 });

    retry.request();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS / 2);

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('does not acquire when a usable token already exists', async () => {
    const acquire = vi.fn(async () => true);
    const retry = new SigningTokenRetry({ acquire, hasToken: () => true });

    retry.request();
    retry.notifyOnline();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS);

    expect(acquire).not.toHaveBeenCalled();
  });

  it('ignores online events until a token has been requested', async () => {
    const acquire = vi.fn(async () => true);
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0 });

    retry.notifyOnline();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS);

    expect(acquire).not.toHaveBeenCalled();
  });

  it('brings a long backoff forward to the online jitter window when the network comes back', async () => {
    const { acquire, settle } = controllableAcquire();
    // 乱数 0.5: バックオフは上限の 3/4、online の待ちは窓の半分
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0.5 });

    retry.request();
    for (let i = 0; i < 8; i++) {
      await settle(false);
      await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS);
    }
    await settle(false);
    expect(retry.state).toBe('waiting');
    const before = acquire.mock.calls.length;

    retry.notifyOnline();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS / 2);

    expect(acquire).toHaveBeenCalledTimes(before + 1);
    retry.dispose();
  });

  it('retries within the online window when the network came back during a failing acquisition', async () => {
    const { acquire, settle } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0.5 });

    retry.request();
    for (let i = 0; i < 6; i++) {
      await settle(false);
      await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS);
    }
    expect(retry.state).toBe('in-flight');
    const before = acquire.mock.calls.length;

    retry.notifyOnline();
    await settle(false);
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS / 2);

    expect(acquire).toHaveBeenCalledTimes(before + 1);
    retry.dispose();
  });

  it('does not send while the browser reports being offline', async () => {
    const { acquire, settle } = controllableAcquire();
    let online = true;
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, isOnline: () => online, random: () => 0 });

    retry.request();
    online = false;
    await settle(false);
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS * 5);
    expect(acquire).toHaveBeenCalledTimes(1);

    online = true;
    retry.notifyOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledTimes(2);
    retry.dispose();
  });

  it('counts an externally started acquisition as the one in flight and takes over when it fails', async () => {
    const { acquire } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0 });
    let failGate: (ok: boolean) => void = () => {};
    const gateAttempt = new Promise<boolean>((resolve) => {
      failGate = resolve;
    });

    retry.track(gateAttempt);
    retry.request();
    expect(acquire).not.toHaveBeenCalled();

    failGate(false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS / 2);
    expect(acquire).toHaveBeenCalledTimes(1);
    retry.dispose();
  });

  it('spreads the acquisitions of 100 devices that come back online at the same moment across the jitter window', async () => {
    const random = seededRandom(236);
    let onlineAt = 0;
    const startedAfterOnline: number[] = [];
    const devices = Array.from({ length: 100 }, () => {
      let calls = 0;
      return new SigningTokenRetry({
        // 起動時の 1 回目は網が落ちていて失敗し、online の後の取得は通る
        acquire: async () => {
          calls += 1;
          if (calls === 1) return false;
          startedAfterOnline.push(Date.now() - onlineAt);
          return true;
        },
        hasToken: () => false,
        random,
      });
    });
    for (const device of devices) device.request();
    await flushMicrotasks();
    expect(devices.every((device) => device.state === 'waiting')).toBe(true);

    onlineAt = Date.now();
    for (const device of devices) device.notifyOnline();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS);

    // 全台が窓の中で 1 回ずつ試す。ジッタが無ければ 100 台が同じ瞬間に叩く
    expect(startedAfterOnline).toHaveLength(100);
    const perSecond = new Map<number, number>();
    for (const ms of startedAfterOnline) {
      expect(ms).toBeLessThan(SIGNING_TOKEN_ONLINE_JITTER_MS);
      const bucket = Math.floor(ms / 1000);
      perSecond.set(bucket, (perSecond.get(bucket) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(20);
  });
});
