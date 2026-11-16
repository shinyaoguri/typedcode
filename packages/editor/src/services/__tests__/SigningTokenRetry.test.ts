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

describe('SigningTokenRetry on TOKEN_EXPIRED (#682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * サーバと token の持ち方を模す: 取得が通ると usable な token が 1 本でき、reportRejected の前に
   * 呼び出し側 (TabManager) がそれを使えないと記憶する (hasToken が偽に戻る)
   */
  function expiringTokens(retryOptions: { random?: () => number } = {}) {
    let usable = true;
    let inFlight = 0;
    let maxInFlight = 0;
    const startedAt: number[] = [];
    const rejectedAt: number[] = [];
    const acquire = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      startedAt.push(Date.now());
      await Promise.resolve();
      inFlight -= 1;
      usable = true;
      return true;
    });
    const retry = new SigningTokenRetry({ acquire, hasToken: () => usable, random: () => 0, ...retryOptions });
    return {
      retry,
      acquire,
      startedAt,
      rejectedAt,
      maxInFlight: () => maxInFlight,
      /** sign が TOKEN_EXPIRED を返した: 今の token を使えないと記憶して報告する */
      expire: () => {
        rejectedAt.push(Date.now());
        usable = false;
        retry.reportRejected();
      },
    };
  }

  it('re-acquires a token right away when the server first rejects the current one as expired', async () => {
    const { retry, acquire, expire } = expiringTokens();

    expire();
    await flushMicrotasks();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(retry.state).toBe('idle');
    retry.dispose();
  });

  it('does not acquire on an expiry report while another usable token is already resolved', async () => {
    const acquire = vi.fn(async () => true);
    const retry = new SigningTokenRetry({ acquire, hasToken: () => true });

    retry.reportRejected();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_MAX_MS);

    expect(acquire).not.toHaveBeenCalled();
    retry.dispose();
  });

  it('backs off exponentially up to the cap, one acquisition at a time, while re-acquired tokens keep expiring', async () => {
    const { retry, acquire, startedAt, rejectedAt, maxInFlight, expire } = expiringTokens();

    // 取り直した token もサーバが即座に期限切れと返し続ける (時計ずれ等)。取得が決着した直後の sign で拒否される
    acquire.mockImplementation(async () => {
      startedAt.push(Date.now());
      setTimeout(expire, 0);
      return true;
    });
    expire();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // random=0 で拒否 n 回目 (n>=2) の後は min(max, base·2^(n-2)) / 2 を待つ。連打なら 1 時間で何千回にもなる
    // (拒否 1 回目はすぐ取り直すので、待ちは拒否 2 回目から数える)
    const gaps = startedAt.slice(1).map((t, i) => t - rejectedAt[i + 1]!);
    expect(startedAt[0]).toBe(rejectedAt[0]);
    expect(gaps[0]).toBe(SIGNING_TOKEN_RETRY_BASE_MS / 2);
    expect(gaps[1]).toBe(SIGNING_TOKEN_RETRY_BASE_MS);
    expect(gaps[2]).toBe(SIGNING_TOKEN_RETRY_BASE_MS * 2);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(SIGNING_TOKEN_RETRY_BASE_MS / 2);
      expect(gap).toBeLessThanOrEqual(SIGNING_TOKEN_RETRY_MAX_MS);
    }
    expect(gaps.at(-1)).toBe(SIGNING_TOKEN_RETRY_MAX_MS / 2);
    expect(acquire.mock.calls.length).toBeLessThan(30);
    expect(maxInFlight()).toBeLessThanOrEqual(1);
    retry.dispose();
  });

  it('ignores further expiry reports while an acquisition is in flight or waiting', async () => {
    const { acquire, settle } = controllableAcquire();
    const retry = new SigningTokenRetry({ acquire, hasToken: () => false, random: () => 0 });

    retry.reportRejected();
    retry.reportRejected();
    retry.request();
    expect(acquire).toHaveBeenCalledTimes(1);
    await settle(false);
    // 失敗のバックオフ待ちの間に拒否が報告されても、待機を早めない
    retry.reportRejected();
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS / 2 - 1);
    expect(acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    retry.dispose();
  });

  it('re-acquires right away again once a re-acquired token has been accepted by the server', async () => {
    const { retry, acquire, expire } = expiringTokens();

    expire();
    await flushMicrotasks();
    retry.reportAccepted(); // 取り直した token で sign が通った
    expire(); // 何十日も後に、その token も期限切れになった
    await flushMicrotasks();

    expect(acquire).toHaveBeenCalledTimes(2);
    retry.dispose();
  });
});
