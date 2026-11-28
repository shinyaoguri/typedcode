/**
 * タブ切替の履歴 (`tab-switches.json` の元) はセッション単位 (#891)。
 *
 * IndexedDB の tabSwitches は sessionId で引く (`getTabSwitches(sessionId)`) ので、ブラウザのタブを閉じて再開すると
 * 今のセッションの履歴だけが戻る。メモリの履歴もこれと同じものにする:
 * - sessionStorage の控えが別のセッションのもの (最後のタブを閉じてからリロードすると、開いたタブが無いので
 *   新しいセッションになる) なら、控えの履歴を持ち越さず、今のセッションの履歴 (IndexedDB) を使う。
 *   sessionId を持たない V1 の控えも、どのセッションのものか分からないので同じ扱い
 * - テンプレートの取り込み (`closeAllTabs`) は同じセッションの中の操作なので、履歴を空にしない
 *   (メモリだけ空にすると、IndexedDB には残っていて、閉じて再開すると古い履歴が戻る)
 *
 * 本物の TabManager / SessionStorageService (fake-indexeddb) を使い、境界の Monaco / Turnstile / PoSW Worker /
 * sessionStorage だけスタブする。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { computeHash } from '@typedcode/shared';
import type { FingerprintComponents, HumanAttestationEventData, TabSwitchEvent } from '@typedcode/shared';
import { setStorageNamespace } from '../../../core/storageKeys.js';
import { initSessionStorageService, type SessionStorageService } from '../../../services/SessionStorageService.js';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content, dispose: () => {} }),
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

const { TabManager } = await import('../TabManager.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (TabManager tabSwitchSession Test)',
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

/** PoSW Web Worker のスタブ (すぐ返す) */
class MockPoswWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  addEventListener(): void {}
  terminate(): void {}
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
}

function tabSwitch(toTabId: string, fromTabId: string | null = null): TabSwitchEvent {
  return { timestamp: 1, fromTabId, toTabId, fromFilename: null, toFilename: `${toTabId}.c` };
}

/** sessionStorage の `typedcode-tabs` に置かれた控え (タブ 0 本。最後のタブを閉じた後に保存される形) */
let snapshot: string | null = null;

async function newTabManager() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const internals = tabManager as unknown as { fingerprint: string; fingerprintComponents: FingerprintComponents };
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  return tabManager;
}

describe('TabManager keeps the tab switch history per session (#891)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    snapshot = null;
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(() => snapshot), setItem: vi.fn() });
    // 保存のデバウンスはこのテストの関心ではない (切替の記録は saveTabSwitch で別に書かれる)
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not carry the previous session's tab switches over when a reload starts a new session", async () => {
    service = await initSessionStorageService();
    const previous = await service.createSession();
    await service.saveTabSwitch(tabSwitch('closed-tab'));
    // 最後のタブを閉じてからリロードすると、開いたタブが無いので新しいセッションになる (main.ts)
    await service.createSession();
    snapshot = JSON.stringify({
      version: 2,
      activeTabId: '',
      tabs: {},
      tabOrder: [],
      tabSwitches: [tabSwitch('closed-tab')],
      sessionId: previous.sessionId,
    });

    const tabManager = await newTabManager();
    await tabManager.loadFromStorage();

    expect(tabManager.getTabSwitches()).toEqual([]);
  });

  it("restores the snapshot's tab switches on a reload that resumes the same session", async () => {
    service = await initSessionStorageService();
    const current = await service.createSession();
    snapshot = JSON.stringify({
      version: 2,
      activeTabId: '',
      tabs: {},
      tabOrder: [],
      tabSwitches: [tabSwitch('tab-a'), tabSwitch('tab-b', 'tab-a')],
      sessionId: current.sessionId,
    });

    const tabManager = await newTabManager();
    await tabManager.loadFromStorage();

    expect(tabManager.getTabSwitches()).toEqual([tabSwitch('tab-a'), tabSwitch('tab-b', 'tab-a')]);
  });

  it("takes the current session's history from IndexedDB instead of a V1 snapshot, which names no session", async () => {
    service = await initSessionStorageService();
    await service.createSession();
    await service.saveTabSwitch(tabSwitch('current-tab'));
    snapshot = JSON.stringify({
      version: 1,
      activeTabId: '',
      tabs: {},
      tabOrder: [],
      tabSwitches: [tabSwitch('unknown-session-tab')],
    });

    const tabManager = await newTabManager();
    await tabManager.loadFromStorage();

    expect(tabManager.getTabSwitches()).toEqual([tabSwitch('current-tab')]);
  });

  it('keeps the same history in memory after a template import as a resume from IndexedDB returns', async () => {
    service = await initSessionStorageService();
    const session = await service.createSession();
    const tabManager = await newTabManager();
    await tabManager.createTab('a.c', 'c', '', { sharedAttestation });
    const b = await tabManager.createTab('b.c', 'c', '', { sharedAttestation });
    // 2 本目は作っただけではアクティブにならない (UI が続けて切り替える)
    await tabManager.switchTab(b!.id);

    await tabManager.closeAllTabs();
    await tabManager.whenTabsRetired();
    const imported = await tabManager.createTab('main.c', 'c', '', { sharedAttestation });
    // 再開で開いたタブとして戻る行 (実機では保存のデバウンスが置く)
    await service.saveTab({
      id: imported!.id,
      sessionId: session.sessionId,
      filename: 'main.c',
      language: 'c',
      content: '',
      createdAt: 1000,
      lastModifiedAt: 1000,
      lastWrittenEventIndex: -1,
      currentHash: null,
      startTime: 1000,
      verificationState: 'pending',
    });
    // 切替の保存は fire-and-forget なので、3 件 (a・b・取り込んだタブ) が書かれるまで待つ
    await vi.waitFor(async () => expect(await service!.getTabSwitches(session.sessionId)).toHaveLength(3));

    const resumed = await newTabManager();
    expect(await resumed.loadFromIndexedDB(session.sessionId)).toBe(true);

    expect(tabManager.getTabSwitches()).toEqual(resumed.getTabSwitches());
  });
});
