// @vitest-environment happy-dom
/**
 * 背景の署名 token 取得と前面の Turnstile 認証が widget を消し合わないこと (#733)。
 *
 * 前面 (タブ作成の認証モーダル) は `#turnstile-widget-container` に widget を描き、利用者がそれを待つ。
 * 背景の取得 (`TabManager.acquireSigningToken`。exam の署名専用 token と #682 の取り直し) は画面に出さない。
 * 両者が同じ容器を空にしてから描くと、後から始めた側が先の widget を消し、先の側のタイムアウトの後始末が
 * 後の widget を消す。背景は `background: true` で専用の隠し容器に描き、前面の容器と表示状態に触れない。
 *
 * Turnstile は fake: render は容器に要素を足し、`solve` はその要素が DOM に残っているときだけ callback を呼ぶ
 * (容器ごと消された widget は本物でも完了しない)。fetch は session/start に token を返す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStartToken } from '@typedcode/shared';

type TurnstileModule = typeof import('../TurnstileService.js');

async function loadService(): Promise<TurnstileModule> {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  return import('../TurnstileService.js');
}

interface FakeWidget {
  id: string;
  action: string;
  element: HTMLElement;
  callback?: (token: string) => void;
}

/** 描画した widget を action で引ける fake Turnstile */
function installFakeTurnstile() {
  const widgets: FakeWidget[] = [];
  const turnstile = {
    render: (container: HTMLElement, options: { action?: string; callback?: (token: string) => void }) => {
      const id = `widget-${widgets.length + 1}`;
      const element = document.createElement('div');
      element.setAttribute('data-fake-widget', options.action ?? '');
      container.appendChild(element);
      widgets.push({ id, action: options.action ?? '', element, callback: options.callback });
      return id;
    },
    remove: (id: string) => {
      widgets.find((w) => w.id === id)?.element.remove();
    },
    reset: () => {},
    getResponse: () => undefined,
    execute: () => {},
  };
  (window as unknown as { turnstile: typeof turnstile }).turnstile = turnstile;
  const latest = (action: string): FakeWidget | undefined => widgets.filter((w) => w.action === action).at(-1);
  return {
    latest,
    /** 利用者 (または自動判定) がチャレンジを通す。消された widget は完了しない */
    solve: (action: string): boolean => {
      const widget = latest(action);
      if (!widget?.element.isConnected) return false;
      widget.callback?.(`turnstile-${action}`);
      return true;
    },
  };
}

function sessionToken(action: string): SessionStartToken {
  return {
    keyId: 'k1',
    payload: { sessionId: 'session-1', issuedAt: '2026-11-01T00:00:00.000Z', serverNonce: 'n'.repeat(64), action },
    signature: `sig-${action}`,
  } as unknown as SessionStartToken;
}

/** session/start は受け取った Turnstile token の action を写した token を返す */
function stubSessionStartFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { turnstileToken: string };
      const action = body.turnstileToken.replace(/^turnstile-/, '');
      return new Response(JSON.stringify({ success: true, token: sessionToken(action) }), { status: 200 });
    })
  );
}

function track<T>(promise: Promise<T>): { value: T | undefined } {
  const box: { value: T | undefined } = { value: undefined };
  void promise.then((v) => {
    box.value = v;
  });
  return box;
}

const sessionStart = { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) };
const foregroundContainer = (): HTMLElement => document.getElementById('turnstile-widget-container')!;
const challengeContainer = (): HTMLElement => document.getElementById('verification-challenge-container')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // スクリプトは読み込んだことにする (外部ホストに出ない)
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    queueMicrotask(() => (node as unknown as { onload?: () => void }).onload?.());
    return node;
  });
  document.body.innerHTML = `
    <div class="verification-challenge-container hidden" id="verification-challenge-container">
      <div id="turnstile-widget-container"></div>
    </div>`;
  stubSessionStartFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe('background signing-token acquisition vs foreground Turnstile verification (#733)', () => {
  it('lets a foreground verification started during a background acquisition complete with its own widget', async () => {
    const { performTurnstileVerification } = await loadService();
    const fake = installFakeTurnstile();

    const background = track(performTurnstileVerification('checkpoint_signing', { sessionStart, background: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    const foreground = track(performTurnstileVerification('create_tab', { sessionStart }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.latest('create_tab')?.element.parentElement).toBe(foregroundContainer());

    // 背景の widget が先にタイムアウトしても (対話チャレンジは背景では解けない)、前面の widget と表示は残る
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fake.latest('create_tab')?.element.isConnected).toBe(true);
    expect(challengeContainer().classList.contains('hidden')).toBe(false);

    expect(fake.solve('create_tab')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(foreground.value).toMatchObject({ success: true, sessionToken: sessionToken('create_tab') });
    expect(background.value).toBeUndefined();
  });

  it('keeps the foreground widget when a background acquisition starts during it, and the background still succeeds', async () => {
    const { performTurnstileVerification } = await loadService();
    const fake = installFakeTurnstile();

    const foreground = track(performTurnstileVerification('create_tab', { sessionStart }));
    await vi.advanceTimersByTimeAsync(0);
    const background = track(performTurnstileVerification('checkpoint_signing', { sessionStart, background: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.latest('create_tab')?.element.isConnected).toBe(true);
    // 背景の widget は前面の容器ではなく、画面に出ない専用の容器に描く
    const backgroundWidget = fake.latest('checkpoint_signing')?.element;
    expect(backgroundWidget?.isConnected).toBe(true);
    expect(foregroundContainer().contains(backgroundWidget ?? null)).toBe(false);
    expect(backgroundWidget?.closest('[hidden]')).not.toBeNull();

    expect(fake.solve('checkpoint_signing')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(background.value).toMatchObject({ success: true, sessionToken: sessionToken('checkpoint_signing') });
    // 背景の後始末は前面の widget と表示に触れない
    expect(fake.latest('create_tab')?.element.isConnected).toBe(true);
    expect(challengeContainer().classList.contains('hidden')).toBe(false);

    expect(fake.solve('create_tab')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(foreground.value).toMatchObject({ success: true, sessionToken: sessionToken('create_tab') });
  });

  it('does not report background acquisition phases to the foreground verification UI', async () => {
    const service = await loadService();
    const fake = installFakeTurnstile();
    const onPhase = vi.fn();
    service.setPhaseCallback(onPhase);

    void service.performTurnstileVerification('checkpoint_signing', { sessionStart, background: true });
    await vi.advanceTimersByTimeAsync(0);
    fake.solve('checkpoint_signing');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onPhase).not.toHaveBeenCalled();
  });

  it('removes the background widget container once the background acquisition settles', async () => {
    const { performTurnstileVerification } = await loadService();
    const fake = installFakeTurnstile();

    const background = track(performTurnstileVerification('checkpoint_signing', { sessionStart, background: true }));
    await vi.advanceTimersByTimeAsync(0);
    const holder = fake.latest('checkpoint_signing')?.element.parentElement;
    expect(holder?.isConnected).toBe(true);

    fake.solve('checkpoint_signing');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(background.value).toMatchObject({ success: true });
    expect(holder?.isConnected).toBe(false);
  });
});
