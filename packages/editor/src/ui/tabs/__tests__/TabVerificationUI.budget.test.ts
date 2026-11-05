/**
 * performVerificationWithUI の予算 (#375) のテスト。
 *
 * タブ作成時の認証は予算で打ち切り、モーダルを閉じて失敗 (timeout) を返す。裏で走り続ける認証が
 * 後で session/start の token を返したら、それを `lateSessionToken` で渡す (呼び出し側が署名専用に回す)。
 * モーダルを閉じた後は、裏の実行のフェーズ通知がステップ表示 (次のタブ作成と共有の DOM) に触らない。
 * node 環境には DOM が無いので、要素と requestAnimationFrame だけスタブし、TurnstileService は境界ごと差し替える。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStartToken } from '@typedcode/shared';
import type { PhaseCallback, VerificationResult } from '../../../services/TurnstileService.js';

const turnstile = vi.hoisted(() => ({
  performTurnstileVerification: vi.fn(),
  setPhaseCallback: vi.fn(),
  setRetryStatusCallback: vi.fn(),
}));

vi.mock('../../../services/TurnstileService.js', () => turnstile);

const { performVerificationWithUI } = await import('../TabVerificationUI.js');

const BUDGET_MS = 15_000;

/** getElementById が返す要素のスタブ (class・dataset・style だけを持つ) */
interface FakeElement {
  classes: Set<string>;
  classList: { add: (c: string) => void; remove: (c: string) => void };
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
}

function fakeElement(initial: string[] = []): FakeElement {
  const classes = new Set(initial);
  return {
    classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    dataset: {},
    style: {},
    textContent: '',
  };
}

let elements: Record<string, FakeElement>;

const t = (key: string) => key;

const sessionToken = {
  keyId: 'k1',
  payload: {
    sessionId: 'session-1',
    issuedAt: '2026-11-01T00:00:00.000Z',
    serverNonce: 'n'.repeat(64),
    action: 'create_tab',
    hostname: 'localhost',
  },
  signature: 'sig',
} as unknown as SessionStartToken;

const sessionStart = { sessionId: 'session-1', fingerprintHash: 'f'.repeat(64) };

/** 手で決着させる認証 (performTurnstileVerification の戻り値) */
function deferredVerification() {
  let resolve: (result: VerificationResult) => void = () => {};
  const promise = new Promise<VerificationResult>((r) => {
    resolve = r;
  });
  let signal: AbortSignal | undefined;
  turnstile.performTurnstileVerification.mockImplementation((_action: string, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return promise;
  });
  return { resolve, signal: () => signal };
}

/** 登録されたフェーズのコールバックのうち、最後に登録された null でないもの */
function registeredPhaseCallback(): PhaseCallback {
  const calls = turnstile.setPhaseCallback.mock.calls.filter(([cb]) => cb !== null);
  return calls[calls.length - 1]![0] as PhaseCallback;
}

beforeEach(() => {
  vi.useFakeTimers();
  elements = {
    'verification-loading-modal': fakeElement(['hidden']),
    'verification-dialog': fakeElement(),
    'verification-timeout-progress': fakeElement(),
    'verification-retry-info': fakeElement(['hidden']),
    'step-prepare': fakeElement(),
    'step-challenge': fakeElement(),
    'step-verify': fakeElement(),
  };
  vi.stubGlobal('document', { getElementById: (id: string) => elements[id] ?? null });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('window', {
    location: { hostname: 'localhost' },
    setInterval: () => 1,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  turnstile.performTurnstileVerification.mockReset();
  turnstile.setPhaseCallback.mockReset();
  turnstile.setRetryStatusCallback.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('performVerificationWithUI budget (#375)', () => {
  it('closes the modal and returns a timeout failure when verification does not finish within the budget', async () => {
    const verification = deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    expect(elements['verification-loading-modal']!.classes.has('hidden')).toBe(false);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const ui = await pending;

    expect(ui.verificationState).toBe('failed');
    expect(ui.result).toMatchObject({ success: false, failureReason: 'timeout' });
    expect(ui.attestationData).toMatchObject({ success: false, failureReason: 'timeout' });
    expect(ui.sessionToken).toBeNull();
    expect(elements['verification-loading-modal']!.classes.has('hidden')).toBe(true);
    // 認証を中断させている (表示中のチャレンジも打ち切る)
    expect(verification.signal()?.aborted).toBe(true);
  });

  it('resolves lateSessionToken to the session/start token that arrives after the budget', async () => {
    const verification = deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const ui = await pending;

    verification.resolve({ success: true, score: 1, sessionToken });
    await expect(ui.lateSessionToken).resolves.toBe(sessionToken);
  });

  it('resolves lateSessionToken to null when the verification that outlived the budget fails', async () => {
    const verification = deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const ui = await pending;

    verification.resolve({ success: false, error: 'HTTP 503', failureReason: 'network_error' });
    await expect(ui.lateSessionToken).resolves.toBeNull();
  });

  it('returns the session token as before and no late token when verification finishes within the budget', async () => {
    const verification = deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    verification.resolve({ success: true, score: 1, sessionToken });
    const ui = await pending;

    expect(ui.verificationState).toBe('verified');
    expect(ui.sessionToken).toBe(sessionToken);
    expect(verification.signal()?.aborted).toBe(false);
    await expect(ui.lateSessionToken).resolves.toBeNull();
    // 予算のタイマーは片付いている (後から中断しない)
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(verification.signal()?.aborted).toBe(false);
  });

  it('unregisters its callbacks when the budget runs out, before the outlived verification settles', async () => {
    deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await pending;

    expect(turnstile.setPhaseCallback).toHaveBeenLastCalledWith(null);
    expect(turnstile.setRetryStatusCallback).toHaveBeenLastCalledWith(null);
  });

  it('ignores phase updates from the outlived verification after the modal is closed', async () => {
    deferredVerification();

    const pending = performVerificationWithUI('create_tab', t, sessionStart, { budgetMs: BUDGET_MS });
    const onPhase = registeredPhaseCallback();
    onPhase('prepare', 'done');
    expect(elements['step-prepare']!.dataset.status).toBe('done');
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await pending;

    // 次のタブ作成が同じステップ表示を使っている間に、裏の実行が通知してくる
    elements['step-verify']!.dataset.status = 'pending';
    onPhase('verify', 'error');
    expect(elements['step-verify']!.dataset.status).toBe('pending');
  });
});
