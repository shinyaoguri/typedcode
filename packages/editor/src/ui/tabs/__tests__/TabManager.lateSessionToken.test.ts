/**
 * タブ作成時の認証の予算切れと、遅れて届いた session/start token の扱い (#375)。
 *
 * 予算を過ぎたタブは非アンカー (`initialize`) で始め、root は確定済みなので後から届いた token を焼かない
 * (proof の `sessionStartToken` は無いまま)。その token は署名専用 token として `findSigningToken` が
 * 返すようにし、全タブの待機中の署名を再開させる (ADR-0027)。
 * Monaco / Turnstile の UI / IndexedDB / 署名サービスは node 環境に無いので境界だけスタブし、
 * TypingProof は本物を使う。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeHash, TypingProof } from '@typedcode/shared';
import type { FingerprintComponents, SessionStartToken } from '@typedcode/shared';
import type { VerificationUIResult } from '../TabVerificationUI.js';
import { TAB_CREATE_VERIFICATION_BUDGET_MS } from '../../../config/timeouts.js';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: () => {},
  },
}));

vi.mock('../../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => true,
  performTurnstileVerification: vi.fn(),
}));

const ui = vi.hoisted(() => ({ performVerificationWithUI: vi.fn() }));
vi.mock('../TabVerificationUI.js', () => ui);

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

const lateToken = {
  keyId: 'k1',
  payload: {
    sessionId: 'session-1',
    issuedAt: '2026-11-01T00:00:15.000Z',
    serverNonce: 'n'.repeat(64),
    action: 'create_tab',
    hostname: 'localhost',
  },
  signature: 'sig',
} as unknown as SessionStartToken;

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

/** 予算切れで返った認証の結果。lateSessionToken は手で決着させる。 */
function budgetExceeded(): { result: VerificationUIResult; deliver: (token: SessionStartToken | null) => void } {
  let deliver: (token: SessionStartToken | null) => void = () => {};
  const lateSessionToken = new Promise<SessionStartToken | null>((resolve) => {
    deliver = resolve;
  });
  return {
    result: {
      verificationState: 'failed',
      verificationDetails: { timestamp: '2026-11-01T00:00:15.000Z', failureReason: 'timeout' },
      attestationData: {
        verified: false,
        score: 0,
        action: 'create_tab',
        timestamp: '2026-11-01T00:00:15.000Z',
        hostname: 'localhost',
        signature: 'unsigned',
        success: false,
        failureReason: 'timeout',
      },
      result: { success: false, error: 'budget_exceeded', failureReason: 'timeout' },
      sessionToken: null,
      lateSessionToken,
    },
    deliver,
  };
}

interface TabManagerInternals {
  fingerprint: string;
  fingerprintComponents: FingerprintComponents;
  findSigningToken: () => SessionStartToken | null;
}

async function setup() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage / IndexedDB を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as TabManagerInternals;
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  return { tabManager, internals };
}

/** 未決着の then を流す */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('TabManager createTab with a verification budget (#375)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ui.performVerificationWithUI.mockReset();
    signing.services.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('asks the verification UI to give up after TAB_CREATE_VERIFICATION_BUDGET_MS', async () => {
    const { tabManager } = await setup();
    ui.performVerificationWithUI.mockResolvedValue(budgetExceeded().result);

    await tabManager.createTab('a.c', 'c', '');

    expect(ui.performVerificationWithUI).toHaveBeenCalledWith(
      'create_tab',
      expect.any(Function),
      expect.objectContaining({ sessionId: 'session-1' }),
      { budgetMs: TAB_CREATE_VERIFICATION_BUDGET_MS }
    );
  });

  it('starts an over-budget tab unanchored and keeps the late token out of its proof', async () => {
    const { tabManager } = await setup();
    const auth = budgetExceeded();
    ui.performVerificationWithUI.mockResolvedValue(auth.result);
    const initialize = vi.spyOn(TypingProof.prototype, 'initialize');
    const initializeAnchored = vi.spyOn(TypingProof.prototype, 'initializeAnchored');

    const tab = await tabManager.createTab('a.c', 'c', '');
    auth.deliver(lateToken);
    await flushMicrotasks();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initializeAnchored).not.toHaveBeenCalled();
    expect(tab?.typingProof.sessionStartToken).toBeNull();
    expect(tab?.verificationState).toBe('failed');
    expect(tab?.typingProof.events[0]?.type).toBe('humanAttestation');
  });

  it('uses the late token as the signing token and resumes pending signatures on every tab', async () => {
    const { tabManager, internals } = await setup();
    const first = budgetExceeded();
    const second = budgetExceeded();
    ui.performVerificationWithUI.mockResolvedValueOnce(first.result).mockResolvedValueOnce(second.result);

    await tabManager.createTab('a.c', 'c', '');
    await tabManager.createTab('b.c', 'c', '');
    expect(signing.services).toHaveLength(2);
    expect(internals.findSigningToken()).toBeNull();

    second.deliver(lateToken);
    await flushMicrotasks();

    expect(internals.findSigningToken()).toBe(lateToken);
    for (const service of signing.services) {
      expect(service.retryPendingSignatures).toHaveBeenCalled();
    }
  });

  it('does not touch the signing token when the outlived verification brings no token', async () => {
    const { tabManager, internals } = await setup();
    const auth = budgetExceeded();
    ui.performVerificationWithUI.mockResolvedValue(auth.result);

    await tabManager.createTab('a.c', 'c', '');
    auth.deliver(null);
    await flushMicrotasks();

    expect(internals.findSigningToken()).toBeNull();
    expect(signing.services[0]?.retryPendingSignatures).not.toHaveBeenCalled();
  });
});
