/**
 * performTurnstileVerification の中断 (#375) のテスト。
 *
 * タブ作成時の認証は予算 (TAB_CREATE_VERIFICATION_BUDGET_MS) で打ち切る。token を得るまで
 * (スクリプト読込・チャレンジ) の中断は即座に timeout で返り、表示中の widget を今すぐ片付ける
 * (コンテナは次のタブ作成と共有なので、後から片付けると次の widget を消す)。token を得た後の
 * session/start は止めず、その結果 (遅れて届く token) をそのまま返す。
 * node 環境には DOM も Turnstile も無いので、境界 (document・window.turnstile・fetch) だけスタブする。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStartToken } from '@typedcode/shared';

type TurnstileModule = typeof import('../TurnstileService.js');

/** env を読むのはモジュール評価時なので、stubEnv してから毎回読み直す。 */
async function loadService(): Promise<TurnstileModule> {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  return import('../TurnstileService.js');
}

/** スクリプトの読込: `load` なら次の microtask で onload、`hang` なら何も起きない (配信元が無応答)。 */
function stubDocument(script: 'load' | 'hang'): void {
  vi.stubGlobal('document', {
    createElement: () => ({ remove: () => {} }),
    head: {
      appendChild: (el: { onload?: () => void }) => {
        if (script === 'load') queueMicrotask(() => el.onload?.());
      },
    },
    documentElement: { getAttribute: () => null },
    getElementById: () => null,
  });
}

/** Turnstile の widget: `token` なら描画と同時に token を返す、`pending` ならチャレンジを出したまま返さない。 */
function stubTurnstile(challenge: 'token' | 'pending') {
  const render = vi.fn((_container: unknown, options: { callback?: (token: string) => void }) => {
    if (challenge === 'token') options.callback?.('turnstile-token');
    return 'widget-1';
  });
  const remove = vi.fn();
  vi.stubGlobal('window', { turnstile: { render, remove } });
  return { render, remove };
}

/** 呼び出しを記録し、応答は手で返す fetch。 */
function stubDeferredFetch() {
  const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  let respond: ((response: Response) => void) | null = null;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal ?? undefined });
    return new Promise<Response>((resolve) => {
      respond = resolve;
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls,
    respond: (response: Response) => respond?.(response),
  };
}

/** 共有コンテナのスタブ (描画済みの widget が中に入っている状態) */
function containers() {
  const widgetContainer = { innerHTML: '<iframe></iframe>' } as unknown as HTMLElement;
  const hidden = new Set<string>();
  const parentContainer = {
    classList: {
      add: (c: string) => hidden.add(c),
      remove: (c: string) => hidden.delete(c),
    },
  } as unknown as HTMLElement;
  return { widgetContainer, parentContainer, hidden };
}

/** 決着したら値を入れる (fake timers を進めずに「即座に返ったか」を見るため)。 */
function track<T>(promise: Promise<T>): { value: T | undefined } {
  const box: { value: T | undefined } = { value: undefined };
  void promise.then((v) => {
    box.value = v;
  });
  return box;
}

const sessionToken = {
  keyId: 'k1',
  payload: { sessionId: 'session-1', issuedAt: '2026-11-01T00:00:00.000Z', serverNonce: 'n'.repeat(64) },
  signature: 'sig',
} as unknown as SessionStartToken;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
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

describe('performTurnstileVerification abort (#375)', () => {
  it('returns a timeout failure as soon as it is aborted while the Turnstile script is still loading', async () => {
    const { performTurnstileVerification } = await loadService();
    stubDocument('hang');
    const { fetchMock } = stubDeferredFetch();
    const controller = new AbortController();

    const result = track(performTurnstileVerification('create_tab', { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.value).toBeUndefined();

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toMatchObject({ success: false, failureReason: 'timeout' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes the displayed challenge widget and returns a timeout failure as soon as it is aborted', async () => {
    const { performTurnstileVerification } = await loadService();
    stubDocument('load');
    const { render, remove } = stubTurnstile('pending');
    const { fetchMock } = stubDeferredFetch();
    const { widgetContainer, parentContainer, hidden } = containers();
    const controller = new AbortController();

    const result = track(
      performTurnstileVerification('create_tab', { widgetContainer, parentContainer, signal: controller.signal })
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.value).toBeUndefined();

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toMatchObject({ success: false, failureReason: 'timeout' });
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(widgetContainer.innerHTML).toBe('');
    expect(hidden.has('hidden')).toBe(true);
    // 中断の後にチャレンジを出し直さない (次のタブ作成のコンテナに描かない)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(render).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a token acquired just before the abort and still calls session/start with it', async () => {
    const { performTurnstileVerification } = await loadService();
    stubDocument('load');
    stubTurnstile('token');
    const { calls } = stubDeferredFetch();
    const { widgetContainer } = containers();
    const controller = new AbortController();

    void performTurnstileVerification('create_tab', {
      widgetContainer,
      sessionStart: { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) },
      signal: controller.signal,
    });
    // token は得たが、成功表示の待ち (1.5 秒) の途中で中断する
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map((c) => c.url)).toEqual(['http://api.test/api/session/start']);
  });

  it('does not stop session/start when aborted after the token is acquired, and returns its late token', async () => {
    const { performTurnstileVerification } = await loadService();
    stubDocument('load');
    stubTurnstile('token');
    const { calls, respond } = stubDeferredFetch();
    const { widgetContainer } = containers();
    const controller = new AbortController();

    const result = track(
      performTurnstileVerification('create_tab', {
        widgetContainer,
        sessionStart: { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) },
        signal: controller.signal,
      })
    );
    // 成功表示の待ち (1.5 秒) を過ぎて session/start に入ってから中断する
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.value).toBeUndefined();
    expect(calls[0]?.signal?.aborted).toBe(false);

    respond(new Response(JSON.stringify({ success: true, token: sessionToken }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toMatchObject({ success: true, sessionToken });
  });

  it('keeps reporting phases to the callbacks registered when the run started, not to ones registered later', async () => {
    const { performTurnstileVerification, setPhaseCallback } = await loadService();
    stubDocument('load');
    stubTurnstile('token');
    const { respond } = stubDeferredFetch();
    const { widgetContainer } = containers();
    const first = vi.fn();
    const second = vi.fn();

    setPhaseCallback(first);
    const result = track(
      performTurnstileVerification('create_tab', {
        widgetContainer,
        sessionStart: { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) },
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    // 次のタブ作成の UI が自分のコールバックを登録した
    setPhaseCallback(second);
    await vi.advanceTimersByTimeAsync(1_500);
    respond(new Response(JSON.stringify({ success: true, token: sessionToken }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toMatchObject({ success: true });
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledWith('verify', 'done');
  });
});
