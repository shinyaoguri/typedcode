/**
 * TabManager.saveToIndexedDB の二重インスタンス競合の扱い (#484 / #237)。
 *
 * 保存層 (SessionStorageService.appendEvent) が EventChainConflictError で拒否したタブは、
 * - 自分のスナップショットで tabs レコードを上書きしない (saveTab を呼ばない)
 * - 保存全体を失敗させず、ほかのタブの保存は続ける
 * Monaco / Turnstile / IndexedDB は node 環境に無いので境界だけスタブする。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const sessionService = {
  getCurrentSessionId: () => 'session-1',
  isInitialized: () => true,
  getEvents: vi.fn(async () => []),
  appendEvent: vi.fn(async (_tabId: string, _event: unknown) => {}),
  saveTab: vi.fn(async (_tab: { id: string }) => {}),
  updateActiveTabId: vi.fn(async () => {}),
  updateTabOrder: vi.fn(async () => {}),
};

vi.mock('../../../services/SessionStorageService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/SessionStorageService.js')>();
  return { ...actual, getSessionStorageService: () => sessionService };
});

const { TabManager } = await import('../TabManager.js');
const { EventChainConflictError } = await import('../../../services/SessionStorageService.js');

interface TabManagerInternals {
  saveToIndexedDB: () => Promise<void>;
  tabs: Map<string, unknown>;
}

function tabWithEvents(): unknown {
  return {
    filename: 'a.ts',
    language: 'typescript',
    model: { getValue: () => '' },
    createdAt: 0,
    verificationState: 'pending',
    verificationDetails: undefined,
    typingProof: {
      serializeState: () => ({
        events: [{ sequence: 0, hash: 'hash-0' }],
        currentHash: 'hash-0',
        initialHashNonce: 'n',
        startTime: 0,
        checkpoints: [],
        examContext: undefined,
        sessionStartToken: null,
      }),
    },
  };
}

function setup(): TabManagerInternals {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const internals = tabManager as unknown as TabManagerInternals;
  internals.tabs.set('tab-conflict', tabWithEvents());
  internals.tabs.set('tab-ok', tabWithEvents());
  return internals;
}

function savedTabIds(): string[] {
  return sessionService.saveTab.mock.calls.map((call) => call[0].id);
}

describe('TabManager.saveToIndexedDB when the storage layer rejects a conflicting chain (#484)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionService.appendEvent.mockImplementation(async (tabId: string) => {
      if (tabId === 'tab-conflict') throw new EventChainConflictError(tabId, 0, 'hash-A', 'hash-0');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not overwrite the tab record of the conflicting tab with this instance snapshot', async () => {
    const internals = setup();

    await internals.saveToIndexedDB();

    expect(savedTabIds()).not.toContain('tab-conflict');
  });

  it('still saves the other tabs and does not fail the whole save', async () => {
    const internals = setup();

    await expect(internals.saveToIndexedDB()).resolves.toBeUndefined();

    expect(savedTabIds()).toEqual(['tab-ok']);
  });

  it('propagates storage failures other than a chain conflict', async () => {
    const internals = setup();
    sessionService.appendEvent.mockImplementation(async () => {
      throw new Error('Failed to append event');
    });

    await expect(internals.saveToIndexedDB()).rejects.toThrow('Failed to append event');
  });
});
