/**
 * checkpoint の作成と署名の付与が永続化を要求すること (#654)。
 *
 * 保存のきっかけがイベントの記録だけだと、export で作った最終 checkpoint とその署名は IndexedDB に
 * 届かない。export の後に打鍵せず閉じたタブは署名前の checkpoints で復元され、次の checkpoint を
 * サーバ側の既存 index で送って 409 CHECKPOINT_CONFLICT になる。
 * Monaco / Turnstile の UI / IndexedDB / 署名サービスは node 環境に無いので境界だけスタブし、
 * TypingProof は本物を使う (TabManager.lateSessionToken.test.ts と同じ流儀)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeHash } from '@typedcode/shared';
import type { FingerprintComponents, SignedCheckpointEnvelope } from '@typedcode/shared';
import type { SignedCheckpointServiceOptions } from '../../../services/SignedCheckpointService.js';
import type { VerificationUIResult } from '../TabVerificationUI.js';

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

/** 署名サービスに渡った options (タブを作った順に並ぶ) */
const signing = vi.hoisted(() => ({
  options: [] as SignedCheckpointServiceOptions[],
}));
vi.mock('../../../services/SignedCheckpointService.js', () => ({
  createSignedCheckpointServiceIfEnabled: (options: SignedCheckpointServiceOptions) => {
    signing.options.push(options);
    return { retryPendingSignatures: vi.fn(), handleNewCheckpoint: vi.fn(), restore: vi.fn() };
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

const envelope = {
  payload: { eventIndex: 0 },
  signature: 'sig',
  keyId: 'k1',
} as unknown as SignedCheckpointEnvelope;

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

/** 認証に失敗した結果 (非アンカーで始める。署名サービスの attach には関係しない) */
const failedVerification: VerificationUIResult = {
  verificationState: 'failed',
  verificationDetails: { timestamp: '2026-11-01T00:00:00.000Z', failureReason: 'network_error' },
  attestationData: {
    verified: false,
    score: 0,
    action: 'create_tab',
    timestamp: '2026-11-01T00:00:00.000Z',
    hostname: 'localhost',
    signature: 'unsigned',
    success: false,
  },
  result: { success: false, error: 'network_error' },
  sessionToken: null,
  lateSessionToken: Promise.resolve(null),
} as unknown as VerificationUIResult;

interface TabManagerInternals {
  fingerprint: string;
  fingerprintComponents: FingerprintComponents;
}

/** タブを 1 つ作り、署名サービスに渡った options と saveToStorage の spy を返す */
async function setupTab() {
  const save = vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage / IndexedDB を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as TabManagerInternals;
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  ui.performVerificationWithUI.mockResolvedValue(failedVerification);

  const tab = await tabManager.createTab('a.c', 'c', '');
  if (!tab) throw new Error('tab was not created');
  // 作成時の記録が確定してから数える (確定の通知も saveToStorage を呼ぶ)
  await tab.typingProof.waitForQueueDrain();
  const options = signing.options[0];
  if (!options) throw new Error('signed checkpoint service was not attached');
  return { tab, options, save };
}

describe('TabManager persists checkpoints and their signatures (#654)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ui.performVerificationWithUI.mockReset();
    signing.options.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests persistence when a signature is attached to an existing checkpoint', async () => {
    const { tab, options, save } = await setupTab();
    await tab.typingProof.exportProof('');
    const last = tab.typingProof.checkpoints.at(-1);
    if (!last) throw new Error('export did not create a checkpoint');
    save.mockClear();

    const attached = options.attachSignature(last.eventIndex, envelope);

    expect(attached).toBe(true);
    expect(save).toHaveBeenCalled();
  });

  it('does not request persistence when no checkpoint matches the signed event index', async () => {
    const { options, save } = await setupTab();
    save.mockClear();

    const attached = options.attachSignature(9999, envelope);

    expect(attached).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('requests persistence when a checkpoint is created', async () => {
    const { tab, save } = await setupTab();
    save.mockClear();

    await tab.typingProof.exportProof('');

    expect(tab.typingProof.checkpoints.length).toBeGreaterThan(0);
    expect(save).toHaveBeenCalled();
  });
});
