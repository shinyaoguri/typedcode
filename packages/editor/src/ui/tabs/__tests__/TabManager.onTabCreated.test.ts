/**
 * TabManager.setOnTabCreated のテスト (#405)。
 *
 * 新しく作ったタブに起動時ワンショットを流し直すフック。#0 humanAttestation の記録より後、
 * かつタブの登録 (tabs.set) と同じ同期区間で呼ばれることが、二重記録・取りこぼしを防ぐ前提になる。
 * Monaco / Turnstile / IndexedDB は node 環境に無いので境界だけスタブし、TypingProof は本物を使う。
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

/** PoSW Web Worker のスタブ (EventRecorder.test.ts と同じ流儀) */
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

/** コールバックが呼ばれた瞬間の状態を写し取る */
interface CreatedSnapshot {
  tab: TabState;
  eventTypes: string[];
  registered: boolean;
}

async function setup() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage / IndexedDB を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as {
    fingerprint: string;
    fingerprintComponents: FingerprintComponents;
  };
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;

  const created: CreatedSnapshot[] = [];
  tabManager.setOnTabCreated((tab) => {
    created.push({
      tab,
      eventTypes: tab.typingProof.events.map((e) => e.type),
      registered: tabManager.getAllTabs().some((t) => t.id === tab.id),
    });
  });
  return { tabManager, created };
}

describe('TabManager onTabCreated (#405)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    // 保存はデバウンス後に sessionStorage / IndexedDB へ書く。このテストの関心ではない
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls onTabCreated once from createTab, after #0 humanAttestation is on the chain', async () => {
    const { tabManager, created } = await setup();

    const tab = await tabManager.createTab('a.c', 'c', '', { sharedAttestation });

    expect(created).toHaveLength(1);
    expect(created[0]?.tab).toBe(tab);
    expect(created[0]?.eventTypes).toEqual(['humanAttestation']);
  });

  it('calls onTabCreated from createTab only after the tab is registered in getAllTabs', async () => {
    const { tabManager, created } = await setup();

    await tabManager.createTab('a.c', 'c', '', { sharedAttestation });

    expect(created[0]?.registered).toBe(true);
  });

  it('calls onTabCreated once from createTabFromTemplate, after #0 humanAttestation is on the chain', async () => {
    const { tabManager, created } = await setup();

    const tab = await tabManager.createTabFromTemplate('b.c', 'c', '', sharedAttestation);

    expect(created).toHaveLength(1);
    expect(created[0]?.tab).toBe(tab);
    expect(created[0]?.eventTypes).toEqual(['humanAttestation']);
  });
});
