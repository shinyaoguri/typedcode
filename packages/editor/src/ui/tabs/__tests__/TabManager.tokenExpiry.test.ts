/**
 * 署名 token の期限切れ (TOKEN_EXPIRED) での取り直し (#682)。
 *
 * - sign が TOKEN_EXPIRED を返した token は、セッション単位で `findSigningToken` の候補から外す
 *   (期限はサーバの応答だけで決める)
 * - 署名専用 token を `SigningTokenRetry` の規律 (同時 1 本・バックオフ) で取り直し、全タブの待機中の署名を再開する
 * - casual/class/assignment でも同じ。取り直した token は root にも proof にも焼かない (root の token は残す)
 * - 取り直した token がすぐまた拒否されても (時計ずれ等)、取得はバーストしない
 *
 * Monaco / Turnstile / IndexedDB / 署名サービスは node 環境に無いので境界だけスタブし、TypingProof は本物を使う。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeHash } from '@typedcode/shared';
import type {
  ExamSessionContext,
  FingerprintComponents,
  SessionStartToken,
  SignedCheckpointEnvelope,
} from '@typedcode/shared';
import type { VerificationUIResult } from '../TabVerificationUI.js';
import type { SignedCheckpointServiceOptions } from '../../../services/SignedCheckpointService.js';
import { SIGNING_TOKEN_RETRY_BASE_MS, SIGNING_TOKEN_RETRY_MAX_MS } from '../../../config/timeouts.js';

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

const ui = vi.hoisted(() => ({ performVerificationWithUI: vi.fn() }));
vi.mock('../TabVerificationUI.js', () => ui);

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => 'session-1',
    isInitialized: () => false,
  }),
}));

/** タブごとに作られる署名サービスのスタブと、TabManager が渡した options (作られた順に並ぶ) */
const signing = vi.hoisted(() => ({
  services: [] as Array<{
    retryPendingSignatures: ReturnType<typeof vi.fn>;
    options: Omit<SignedCheckpointServiceOptions, 'apiUrl'>;
  }>,
}));
vi.mock('../../../services/SignedCheckpointService.js', () => ({
  createSignedCheckpointServiceIfEnabled: (options: Omit<SignedCheckpointServiceOptions, 'apiUrl'>) => {
    const service = { retryPendingSignatures: vi.fn(), handleNewCheckpoint: vi.fn(), restore: vi.fn(), options };
    signing.services.push(service);
    return service;
  },
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { TabManager } = await import('../TabManager.js');

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

/** signature は token ごとに変える (期限切れの記憶は signature で引く) */
function sessionToken(label: string, issuedAt: string): SessionStartToken {
  return {
    keyId: 'k1',
    payload: {
      sessionId: 'session-1',
      issuedAt,
      serverNonce: 'c'.repeat(64),
      action: 'create_tab',
      hostname: 'localhost',
    },
    signature: `sig-${label}`,
  } as unknown as SessionStartToken;
}

const rootToken = sessionToken('root', '2026-10-01T00:00:00.000Z');

/** 予算内に session/start まで通った作成時の認証 (root は rootToken でアンカーされる) */
function anchoredVerification(token: SessionStartToken): VerificationUIResult {
  return {
    verificationState: 'verified',
    verificationDetails: { timestamp: '2026-10-01T00:00:00.000Z' },
    attestationData: {
      verified: true,
      score: 1,
      action: 'create_tab',
      timestamp: '2026-10-01T00:00:00.000Z',
      hostname: 'localhost',
      signature: 'session-start-token:k1',
      success: true,
    },
    result: { success: true, score: 1, action: 'create_tab', sessionToken: token },
    sessionToken: token,
    lateSessionToken: Promise.resolve(null),
  } as unknown as VerificationUIResult;
}

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
  // createPoswWorker が生成時に故障の観測 (#701) を付ける。このスタブは error を出さない
  addEventListener(): void {}
}

interface TabManagerInternals {
  fingerprint: string;
  fingerprintComponents: FingerprintComponents;
  findSigningToken: () => SessionStartToken | null;
}

async function setup() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const internals = tabManager as unknown as TabManagerInternals;
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  return { tabManager, internals };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** sign が TOKEN_EXPIRED を返したことを、そのタブの署名サービスとして TabManager に伝える */
function reportExpired(serviceIndex: number, token: SessionStartToken): void {
  const onTokenExpired = signing.services[serviceIndex]?.options.onTokenExpired;
  expect(onTokenExpired).toBeTypeOf('function');
  onTokenExpired?.(token);
}

describe('TabManager re-acquires the signing token on TOKEN_EXPIRED (#682)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hostname: 'localhost' } }));
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    turnstile.performTurnstileVerification.mockReset();
    ui.performVerificationWithUI.mockReset();
    signing.services.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-acquires a signing-only token in casual mode and resumes signing on every tab, keeping the root token in the proof', async () => {
    const { tabManager, internals } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(anchoredVerification(rootToken));
    const fresh = sessionToken('fresh', '2026-11-01T00:00:00.000Z');
    turnstile.performTurnstileVerification.mockResolvedValue({ success: true, score: 1, sessionToken: fresh });

    const first = await tabManager.createTab('a.c', 'c', '');
    await tabManager.createTab('b.c', 'c', '');
    expect(internals.findSigningToken()).toBe(rootToken);
    expect(turnstile.performTurnstileVerification).not.toHaveBeenCalled();

    reportExpired(0, rootToken);
    await flushMicrotasks();

    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(1);
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledWith(
      'checkpoint_signing',
      expect.objectContaining({ sessionStart: expect.objectContaining({ sessionId: 'session-1' }) })
    );
    expect(internals.findSigningToken()).toBe(fresh);
    for (const service of signing.services) {
      expect(service.retryPendingSignatures).toHaveBeenCalled();
    }
    // 取り直した token は root にも proof にも焼かない
    expect(first?.typingProof.sessionStartToken).toBe(rootToken);
  });

  it('re-acquires the exam signing-only token once the server rejects it as expired', async () => {
    const { tabManager, internals } = await setup();
    const old = sessionToken('old', '2026-10-01T00:00:00.000Z');
    const fresh = sessionToken('fresh', '2026-11-01T00:00:00.000Z');
    turnstile.performTurnstileVerification
      .mockResolvedValueOnce({ success: true, score: 1, sessionToken: old })
      .mockResolvedValueOnce({ success: true, score: 1, sessionToken: fresh });

    await tabManager.createTab('answer.c', 'c', '', { examContext, examVerification: null });
    await flushMicrotasks();
    expect(internals.findSigningToken()).toBe(old);

    reportExpired(0, old);
    await flushMicrotasks();

    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(2);
    expect(internals.findSigningToken()).toBe(fresh);
  });

  it('does not offer the expired token for signing while the re-acquisition is still in flight', async () => {
    const { tabManager, internals } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(anchoredVerification(rootToken));
    turnstile.performTurnstileVerification.mockReturnValue(new Promise(() => {}));

    await tabManager.createTab('a.c', 'c', '');
    reportExpired(0, rootToken);
    await flushMicrotasks();

    expect(internals.findSigningToken()).toBeNull();
    expect(signing.services[0]?.options.getSessionStartToken()).toBeNull();
  });

  it('starts a single re-acquisition when several tabs report the same expired token', async () => {
    const { tabManager } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(anchoredVerification(rootToken));
    turnstile.performTurnstileVerification.mockResolvedValue({
      success: true,
      score: 1,
      sessionToken: sessionToken('fresh', '2026-11-01T00:00:00.000Z'),
    });

    await tabManager.createTab('a.c', 'c', '');
    await tabManager.createTab('b.c', 'c', '');
    await tabManager.createTab('c.c', 'c', '');
    reportExpired(0, rootToken);
    reportExpired(1, rootToken);
    await flushMicrotasks();
    // 取り直しが済んだ後に、応答の遅れたタブが同じ token の拒否を報告しても取り直さない
    reportExpired(2, rootToken);
    await flushMicrotasks();

    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(1);
  });

  it('does not burst session/start when every re-acquired token is rejected as expired again', async () => {
    vi.useFakeTimers();
    const { tabManager } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(anchoredVerification(rootToken));
    let issued = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    turnstile.performTurnstileVerification.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      issued += 1;
      const token = sessionToken(`fresh-${issued}`, '2026-11-01T00:00:00.000Z');
      await Promise.resolve();
      inFlight -= 1;
      // サーバとクライアントの時計ずれ等で、取り直した token も次の sign ですぐ TOKEN_EXPIRED になる
      setTimeout(() => reportExpired(0, token), 1_000);
      return { success: true, score: 1, sessionToken: token };
    });

    await tabManager.createTab('a.c', 'c', '');
    reportExpired(0, rootToken);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // バックオフ (下限 base/2・上限 5 分) が効かなければ、1 秒ごとに取り直して 1 時間で 3,600 回になる
    const calls = turnstile.performTurnstileVerification.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(Math.ceil((60 * 60_000) / (SIGNING_TOKEN_RETRY_MAX_MS / 2)) + 10);
    expect(maxInFlight).toBe(1);
  });

  it('re-acquires right away again after a re-acquired token has been accepted by the server', async () => {
    vi.useFakeTimers();
    const { tabManager } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(anchoredVerification(rootToken));
    const first = sessionToken('first', '2026-11-01T00:00:00.000Z');
    const second = sessionToken('second', '2026-12-01T00:00:00.000Z');
    turnstile.performTurnstileVerification
      .mockResolvedValueOnce({ success: true, score: 1, sessionToken: first })
      .mockResolvedValueOnce({ success: true, score: 1, sessionToken: second });

    await tabManager.createTab('a.c', 'c', '');
    reportExpired(0, rootToken);
    await flushMicrotasks();
    // first で sign が通った (attachSignature が呼ばれる)
    signing.services[0]?.options.attachSignature(0, {} as SignedCheckpointEnvelope);
    reportExpired(0, first);
    await vi.advanceTimersByTimeAsync(SIGNING_TOKEN_RETRY_BASE_MS / 2 - 1);

    // sign が通った後の期限切れは「取り直した token がまた拒否された」ではないので、バックオフを待たない
    expect(turnstile.performTurnstileVerification).toHaveBeenCalledTimes(2);
  });
});
