/**
 * 試験の #0 humanAttestation と署名専用 token (#236)。
 *
 * - 試験開始ゲートの表示中に先行取得した token は、#0 の verified の印と署名専用 token の両方に使う
 * - 解錠の瞬間に先行取得が決着していなければ待たず (ADR-0006)、#0 は合成の印。遅れて届いた token は署名にだけ使う
 * - 署名専用 token の取得に失敗したら、バックオフと online イベントで取り直す (同時 1 本)
 * - token の取得が決着しなくても、タブ作成 (= 編集開始) は待たない
 *
 * Monaco / Turnstile / IndexedDB / 署名サービスは node 環境に無いので境界だけスタブし、TypingProof は本物を使う。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeHash } from '@typedcode/shared';
import type {
  ExamSessionContext,
  FingerprintComponents,
  HumanAttestationEventData,
  SessionStartToken,
} from '@typedcode/shared';
import type { VerificationResult } from '../../../services/TurnstileService.js';
import { SIGNING_TOKEN_ONLINE_JITTER_MS, SIGNING_TOKEN_RETRY_BASE_MS } from '../../../config/timeouts.js';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: () => {},
  },
}));

const turnstile = vi.hoisted(() => ({
  isTurnstileConfigured: () => true,
  performTurnstileVerification: vi.fn(),
}));
vi.mock('../../../services/TurnstileService.js', () => turnstile);

vi.mock('../TabVerificationUI.js', () => ({ performVerificationWithUI: vi.fn() }));

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => 'session-1',
    isInitialized: () => false,
  }),
}));

/** タブごとに作られる署名サービスのスタブ (作られた順に並ぶ) */
const signing = vi.hoisted(() => ({
  services: [] as Array<{ retryPendingSignatures: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../../../services/SignedCheckpointService.js', () => ({
  createSignedCheckpointServiceIfEnabled: () => {
    const service = { retryPendingSignatures: vi.fn(), handleNewCheckpoint: vi.fn(), restore: vi.fn() };
    signing.services.push(service);
    return service;
  },
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (TabManager Test)',
  language: 'en',
  languages: ['en'],
  platform: 'TestOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 860,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

const examContext: ExamSessionContext = {
  examId: 'exam-1',
  problemId: 'p1',
  variant: null,
  packageHash: 'a'.repeat(64),
  problemContentHash: 'b'.repeat(64),
  startToken: 'ABCDEFGH',
};

function sessionToken(issuedAt: string, action: string): SessionStartToken {
  return {
    keyId: 'k1',
    payload: { sessionId: 'session-1', issuedAt, serverNonce: 'n'.repeat(64), action, hostname: 'localhost' },
    signature: 'sig',
  } as unknown as SessionStartToken;
}

const gateToken = sessionToken('2026-11-10T09:00:00.000Z', 'exam_start');

/** PoSW Web Worker のスタブ (TabManager.onTabCreated.test.ts と同じ) */
class MockPoswWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          type: 'posw-result',
          requestId: message.requestId,
          iterations: message.iterations,
          nonce: 'mock-nonce',
          intermediateHash: 'mock-intermediate-hash',
          computeTimeMs: 1,
        },
      } as MessageEvent);
    });
  }

  terminate(): void {}
}

/** 決着を手で制御できる performTurnstileVerification の呼び出し 1 回分 */
function deferredVerification() {
  let settle: (result: VerificationResult) => void = () => {};
  const promise = new Promise<VerificationResult>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

interface TabManagerInternals {
  fingerprint: string;
  fingerprintComponents: FingerprintComponents;
  findSigningToken: () => SessionStartToken | null;
}

const { TabManager } = await import('../TabManager.js');

async function setup() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const internals = tabManager as unknown as TabManagerInternals;
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  return { tabManager, internals };
}

function gateUi() {
  const states: string[] = [];
  return {
    states,
    ui: {
      widgetContainer: {} as HTMLElement,
      parentContainer: {} as HTMLElement,
      onStateChange: (state: string) => states.push(state),
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function firstAttestation(tab: { typingProof: { events: readonly { type: string; data?: unknown }[] } } | null) {
  const first = tab?.typingProof.events[0];
  expect(first?.type).toBe('humanAttestation');
  return first?.data as HumanAttestationEventData;
}

describe('TabManager exam #0 attestation and signing token (#236)', () => {
  let windowStub: EventTarget & { location: { hostname: string } };

  beforeEach(() => {
    windowStub = Object.assign(new EventTarget(), { location: { hostname: 'localhost' } });
    vi.stubGlobal('window', windowStub);
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    turnstile.performTurnstileVerification.mockReset();
    signing.services.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records a verified #0 and adopts the signing token when the gate obtained a token before unlock', async () => {
    const { tabManager, internals } = await setup();
    turnstile.performTurnstileVerification.mockResolvedValueOnce({ success: true, score: 1, sessionToken: gateToken });
    const { states, ui } = gateUi();

    const pre = tabManager.startExamPreAttestation(ui);
    await flushMicrotasks();
    const examVerification = pre?.takeResult() ?? null;
    const tab = await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification });

    const attestation = firstAttestation(tab);
    expect(attestation.verified).toBe(true);
    expect(attestation.signature).toBe('session-start-token:k1');
    expect(tab?.verificationState).toBe('verified');
    expect(states).toEqual(['pending', 'verified']);
    expect(internals.findSigningToken()).toBe(gateToken);
    // gate の token が署名にも使えるので、署名専用の取得を別に始めない
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(1);
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledWith(
      'exam_start',
      expect.objectContaining({ sessionStart: expect.objectContaining({ sessionId: 'session-1' }) })
    );
  });

  it('starts the exam without waiting when the gate attempt is still unresolved and signs with the late token', async () => {
    const { tabManager, internals } = await setup();
    const gate = deferredVerification();
    turnstile.performTurnstileVerification.mockReturnValueOnce(gate.promise);
    const { ui } = gateUi();

    const pre = tabManager.startExamPreAttestation(ui);
    const examVerification = pre?.takeResult() ?? null;
    const tab = await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification });

    expect(examVerification).toBeNull();
    const attestation = firstAttestation(tab);
    expect(attestation.verified).toBe(false);
    expect(attestation.signature).toBe('unsigned');
    // 表示中のチャレンジは止める (token を得た後の session/start なら止まらず結果を返す)
    const options = turnstile.performTurnstileVerification.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    // ゲートの取得が走っている間は、attach からの 2 本目を始めない
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(1);

    gate.settle({ success: true, score: 1, sessionToken: gateToken });
    await flushMicrotasks();

    expect(internals.findSigningToken()).toBe(gateToken);
    expect(signing.services[0]?.retryPendingSignatures).toHaveBeenCalled();
    // #0 は記録済みのまま (遅れた token を root にも #0 にも焼かない)
    expect(firstAttestation(tab).verified).toBe(false);
  });

  it('creates the exam tab while the signing token acquisition never settles', async () => {
    const { tabManager } = await setup();
    turnstile.performTurnstileVerification.mockReturnValue(new Promise(() => {}));

    const tab = await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification: null });

    expect(tab).not.toBeNull();
    expect(firstAttestation(tab).verified).toBe(false);
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledWith('checkpoint_signing', expect.anything());
  });

  it('retries a failed signing token acquisition after a backoff and resumes pending signatures', async () => {
    vi.useFakeTimers();
    const { tabManager, internals } = await setup();
    turnstile.performTurnstileVerification
      .mockResolvedValueOnce({ success: false, failureReason: 'network_error' })
      .mockResolvedValueOnce({ success: true, score: 1, sessionToken: sessionToken('2026-11-10T09:01:00.000Z', 'x') });

    await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification: null });
    await flushMicrotasks();
    expect(internals.findSigningToken()).toBeNull();
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS);

    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(2);
    expect(internals.findSigningToken()).not.toBeNull();
    expect(signing.services[0]?.retryPendingSignatures).toHaveBeenCalled();
  });

  it('retries the signing token acquisition within the jitter window when the browser goes back online', async () => {
    vi.useFakeTimers();
    const { tabManager, internals } = await setup();
    turnstile.performTurnstileVerification.mockResolvedValue({ success: false, failureReason: 'network_error' });

    await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification: null });
    // 何度も失敗してバックオフが online の窓より長くなった状態にする
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5 * 60_000);
    const failedSoFar = turnstile.performTurnstileVerification.mock.calls.length;
    turnstile.performTurnstileVerification.mockResolvedValue({
      success: true,
      score: 1,
      sessionToken: sessionToken('2026-11-10T10:00:00.000Z', 'x'),
    });

    windowStub.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_ONLINE_JITTER_MS);

    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(failedSoFar + 1);
    expect(internals.findSigningToken()).not.toBeNull();
  });

  it('does not offer the gate attestation when Turnstile has no session to start yet', async () => {
    const editor = { setModel: vi.fn() };
    const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
    const { ui, states } = gateUi();

    expect(tabManager.startExamPreAttestation(ui)).toBeNull();
    expect(states).toEqual([]);
    expect(turnstile.performTurnstileVerification).not.toHaveBeenCalled();
  });
});
