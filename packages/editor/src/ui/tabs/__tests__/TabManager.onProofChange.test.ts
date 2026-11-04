/**
 * TabManager.setOnProofChange のテスト (#521)。
 *
 * export 前の attestation など、EventRecorder を通らずに TypingProof へ直接記録する経路があり、
 * そこでステータスバー (状態契約の data-count / data-hash) の追従が抜けていた。TypingProof の
 * pending の増減を TabManager が受けて通知するので、直接の記録でも確定の後に通知が来ることを確かめる。
 * Monaco / Turnstile / sessionStorage は node 環境に無いので境界だけスタブし、TypingProof は本物を使う。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeHash } from '@typedcode/shared';
import type { FingerprintComponents, HumanAttestationEventData } from '@typedcode/shared';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: () => {},
  },
}));

vi.mock('../../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => false,
  performTurnstileVerification: vi.fn(),
}));

vi.mock('../TabVerificationUI.js', () => ({
  performVerificationWithUI: vi.fn(),
}));

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => null,
    isInitialized: () => false,
  }),
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { TabManager } = await import('../TabManager.js');
type TabState = import('../TabManager.js').TabState;

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

const sharedAttestation: HumanAttestationEventData = {
  verified: true,
  score: 1,
  action: 'create_tab',
  timestamp: '2026-01-01T00:00:00.000Z',
  hostname: 'localhost',
  signature: 'mock-signature',
  success: true,
};

/** PoSW Web Worker のスタブ (TabManager.onTabCreated.test.ts と同じ流儀) */
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

/** 通知が来た瞬間のタブの proof の状態 */
interface Observed {
  totalEvents: number;
  currentHash: string | null;
  pendingCount: number;
}

/** microtask とタイマーに積まれた通知を流し切る */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function setup(): Promise<{ tab: TabState; observed: Observed[] }> {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage / IndexedDB を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as {
    fingerprint: string;
    fingerprintComponents: FingerprintComponents;
  };
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;

  const observed: Observed[] = [];
  let tab: TabState | null = null;
  tabManager.setOnProofChange(() => {
    if (!tab) return;
    const stats = tab.typingProof.getStats();
    observed.push({
      totalEvents: stats.totalEvents,
      currentHash: stats.currentHash,
      pendingCount: stats.pendingCount,
    });
  });
  const created = await tabManager.createTab('a.c', 'c', '', { sharedAttestation });
  if (!created) throw new Error('createTab returned null');
  tab = created;
  await flush();
  // タブ作成時の #0 の通知はここでは関心外
  observed.length = 0;
  return { tab: created, observed };
}

describe('TabManager onProofChange (#521)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    // 保存はデバウンス後に sessionStorage / IndexedDB へ書く。このテストの関心ではない
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('notifies after an event recorded directly on the TypingProof is committed to the chain', async () => {
    const { tab, observed } = await setup();

    await tab.typingProof.recordPreExportAttestation({ ...sharedAttestation, action: 'export_proof' });
    await flush();

    expect(observed.at(-1)).toMatchObject({
      totalEvents: tab.typingProof.events.length,
      currentHash: tab.typingProof.currentHash,
    });
    expect(observed.at(-1)?.totalEvents).toBe(2);
  });

  it('notifies after the committed event has left the pending count, so the status bar does not stay "processing"', async () => {
    const { tab, observed } = await setup();

    await tab.typingProof.recordPreExportAttestation({ ...sharedAttestation, action: 'export_proof' });
    await flush();

    expect(observed.at(-1)?.pendingCount).toBe(0);
  });

  it('does not notify synchronously from inside recordEvent, so a status update cannot re-enter itself', async () => {
    const { tab, observed } = await setup();

    const recording = tab.typingProof.recordPreExportAttestation({ ...sharedAttestation, action: 'export_proof' });
    const notifiedSynchronously = observed.length;
    await recording;
    await flush();

    expect(notifiedSynchronously).toBe(0);
    expect(observed.length).toBeGreaterThan(0);
  });
});
