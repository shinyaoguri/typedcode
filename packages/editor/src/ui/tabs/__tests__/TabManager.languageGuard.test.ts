/**
 * TabManager.setTabLanguage の言語 guard (#727)。試験の許可言語は UI の選択肢を経ない言語変更
 * (select の値の直接書き換え・別経路の呼び出し) でも止める。Monaco / Turnstile / sessionStorage は
 * 境界だけスタブし、TypingProof は本物を使う (TabManager.onProofChange.test.ts と同じ流儀)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from '@typedcode/shared';
import type { FingerprintComponents, HumanAttestationEventData } from '@typedcode/shared';

const monacoCalls = vi.hoisted(() => ({ setModelLanguage: [] as string[] }));

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: (_model: unknown, language: string) => monacoCalls.setModelLanguage.push(language),
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

const components = { userAgent: 'Mozilla/5.0 (TabManager Language Test)', timezone: 'UTC' } as FingerprintComponents;

const sharedAttestation: HumanAttestationEventData = {
  verified: true,
  score: 1,
  action: 'create_tab',
  timestamp: '2026-01-01T00:00:00.000Z',
  hostname: 'localhost',
  signature: 'mock-signature',
  success: true,
};

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

async function setup(): Promise<{ tabManager: InstanceType<typeof TabManager>; tab: TabState }> {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const internals = tabManager as unknown as { fingerprint: string; fingerprintComponents: FingerprintComponents };
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  const tab = await tabManager.createTab('a.c', 'c', '', { sharedAttestation });
  if (!tab) throw new Error('createTab returned null');
  monacoCalls.setModelLanguage = [];
  return { tabManager, tab };
}

describe('TabManager.setTabLanguage language guard (#727)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses a language the guard rejects and leaves the tab and its model unchanged', async () => {
    const { tabManager, tab } = await setup();
    tabManager.setLanguageGuard((_tab, language) => language === 'c');

    const changed = tabManager.setTabLanguage(tab.id, 'html');

    expect([changed, tab.language, monacoCalls.setModelLanguage]).toEqual([false, 'c', []]);
  });

  it('changes to a language the guard allows', async () => {
    const { tabManager, tab } = await setup();
    tabManager.setLanguageGuard((_tab, language) => language === 'c' || language === 'python');

    const changed = tabManager.setTabLanguage(tab.id, 'python');

    expect([changed, tab.language]).toEqual([true, 'python']);
  });

  it('passes the tab being changed to the guard', async () => {
    const { tabManager, tab } = await setup();
    const seen: string[] = [];
    tabManager.setLanguageGuard((t) => {
      seen.push(t.id);
      return true;
    });

    tabManager.setTabLanguage(tab.id, 'python');

    expect(seen).toEqual([tab.id]);
  });

  it('changes freely without a guard (casual / class)', async () => {
    const { tabManager, tab } = await setup();

    expect(tabManager.setTabLanguage(tab.id, 'html')).toBe(true);
  });
});
