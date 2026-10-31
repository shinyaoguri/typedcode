/**
 * TurnstileService の Workers fetch タイムアウト (#324) のテスト。
 *
 * `/api/verify-captcha` と `/api/session/start` が無応答だと、タブ作成 (session/start を待つ) や
 * export 前認証が無限に待たされる。1 回の fetch に上限を付け、タイムアウトは既存の失敗経路
 * (verify-captcha は retry → 失敗、session/start は network_error → degraded fallback) に合流する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKERS_FETCH_TIMEOUT_MS } from '../../config/timeouts.js';

type TurnstileModule = typeof import('../TurnstileService.js');

/** env を読むのはモジュール評価時なので、stubEnv してから毎回読み直す。 */
async function loadService(): Promise<TurnstileModule> {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  return import('../TurnstileService.js');
}

/** signal の abort でだけ reject する無応答 fetch。 */
function stubHangingFetch() {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, signals };
}

beforeEach(() => {
  vi.useFakeTimers();
  // `AbortSignal.timeout` は fake timers の対象外なので faked な setTimeout で作り直す
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('verifyTurnstileToken fetch timeout (#324)', () => {
  it('retries a hung /api/verify-captcha request and fails after the attempts are exhausted', async () => {
    const { verifyTurnstileToken } = await loadService();
    const { fetchMock, signals } = stubHangingFetch();

    const pending = verifyTurnstileToken('token');
    // 3 試行 × 上限 + backoff (1s + 2s) を進める。無応答のままなら永久に終わらない。
    await vi.advanceTimersByTimeAsync(WORKERS_FETCH_TIMEOUT_MS * 3 + 3000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('network_error');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});

describe('performTurnstileVerification with sessionStart fetch timeout (#324)', () => {
  it('fails with network_error when /api/session/start never responds', async () => {
    const { performTurnstileVerification } = await loadService();
    const { fetchMock, signals } = stubHangingFetch();

    // Turnstile のスクリプト読込とウィジェットを即時成功させる (node 環境には DOM が無い)
    vi.stubGlobal('document', {
      createElement: () => ({ remove: () => {} }),
      head: {
        appendChild: (script: { onload?: () => void }) => {
          queueMicrotask(() => script.onload?.());
        },
      },
      documentElement: { getAttribute: () => null },
      getElementById: () => null,
    });
    vi.stubGlobal('window', {
      turnstile: {
        render: (_container: unknown, options: { callback?: (token: string) => void }) => {
          options.callback?.('turnstile-token');
          return 'widget-1';
        },
        remove: () => {},
      },
    });

    const pending = performTurnstileVerification('create_tab', {
      widgetContainer: { innerHTML: '' } as unknown as HTMLElement,
      sessionStart: { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) },
    });
    // 成功表示の待ち (1.5s) + session/start の上限
    await vi.advanceTimersByTimeAsync(1500 + WORKERS_FETCH_TIMEOUT_MS);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('network_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
