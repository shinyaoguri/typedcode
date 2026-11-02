/**
 * 閉じたタブの後始末のテスト (#342)。
 *
 * - closeTab / closeAllTabs のあと、そのタブの PoSW Worker が terminate される。
 * - 計算中のイベントがあるタブを閉じても、そのイベントの append が済んでから tabs 行と events 行を
 *   消し、その後に Worker を終了する。`deleteTab` が先に走ると、後から append された events 行が
 *   どのタブにも属さない孤児として IndexedDB に残る。
 *
 * 本物の TabManager / EventRecorder / SessionStorageService (fake-indexeddb) を使い、境界の
 * Monaco / Turnstile / PoSW Worker だけスタブする。PoSW の返答は Worker ごとに止められる
 * (「計算中」を作るため)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { computeHash } from '@typedcode/shared';
import type { FingerprintComponents, HumanAttestationEventData, StoredTabData } from '@typedcode/shared';
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
const { EventRecorder } = await import('../../../core/EventRecorder.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (TabManager closeTab Test)',
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

/** 起きた順に並べる印 (appended:<tabId> / deleted:<tabId> / terminated:<workerIndex>) */
let log: string[] = [];
/** appendEvent を遅くする (IndexedDB が詰まっている状況)。drain が済んでも append は終わっていない窓を作る */
let appendDelayMs = 0;

/** PoSW Web Worker のスタブ。`hold` の間は返答を溜めて「計算中」を作り、release で返す */
class MockPoswWorker {
  static instances: MockPoswWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  hold = false;
  held: Record<string, unknown>[] = [];
  readonly index: number;
  terminated = 0;

  constructor() {
    this.index = MockPoswWorker.instances.length;
    MockPoswWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    if (this.hold) {
      this.held.push(message);
      return;
    }
    this.reply(message);
  }

  release(): void {
    this.hold = false;
    const held = this.held;
    this.held = [];
    for (const message of held) this.reply(message);
  }

  terminate(): void {
    this.terminated++;
    log.push(`terminated:${this.index}`);
  }

  private reply(message: Record<string, unknown>): void {
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

function storedTab(id: string, sessionId: string): StoredTabData {
  return {
    id,
    sessionId,
    filename: `${id}.c`,
    language: 'c',
    content: '',
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
  };
}

const keystroke = {
  type: 'contentChange',
  inputType: 'insertText',
  data: 'a',
  rangeOffset: 0,
  rangeLength: 0,
} as const;

async function setup() {
  const service: SessionStorageService = await initSessionStorageService();
  const session = await service.createSession();

  // 起きた順を記録する。本物の処理は通す
  const appendEvent = service.appendEvent.bind(service);
  vi.spyOn(service, 'appendEvent').mockImplementation(async (tabId, event) => {
    if (appendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, appendDelayMs));
    await appendEvent(tabId, event);
    log.push(`appended:${tabId}`);
  });
  const deleteTab = service.deleteTab.bind(service);
  const deleteTabSpy = vi.spyOn(service, 'deleteTab').mockImplementation(async (tabId) => {
    await deleteTab(tabId);
    log.push(`deleted:${tabId}`);
  });

  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as {
    fingerprint: string;
    fingerprintComponents: FingerprintComponents;
  };
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;

  const recorder = new EventRecorder({ tabManager, getLogViewer: () => null });
  recorder.setInitialized(true);
  tabManager.setTabSettleBarrier((tabId) => recorder.whenTabSettled(tabId));

  /** タブを作り、IndexedDB に tabs 行も置く (実機では保存のデバウンスが置く) */
  async function openTab(filename: string) {
    const tab = await tabManager.createTab(filename, 'c', '', { sharedAttestation });
    await service.saveTab(storedTab(tab!.id, session.sessionId));
    return tab!;
  }

  return { service, tabManager, recorder, openTab, deleteTabSpy };
}

describe('TabManager closing a tab (#342)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    // テストごとに IndexedDB を丸ごと差し替えて分離する
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    log = [];
    appendDelayMs = 0;
    MockPoswWorker.instances = [];
    vi.stubGlobal('Worker', MockPoswWorker);
    // closeAllTabs が sessionStorage のタブ一覧を消す
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(), setItem: vi.fn() });
    // 保存はデバウンス後に sessionStorage / IndexedDB へ書く。このテストの関心ではない
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("terminates the closed tab's PoSW worker after closeTab, and only that tab's", async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    await s.openTab('b.c');

    expect(s.tabManager.closeTab(a.id)).toBe(true);
    await s.tabManager.whenTabsRetired();

    expect(MockPoswWorker.instances.map((w) => w.terminated)).toEqual([1, 0]);
  });

  it('terminates the PoSW worker of every tab after closeAllTabs, including a template tab', async () => {
    const s = await setup();
    service = s.service;
    await s.openTab('a.c');
    await s.tabManager.createTabFromTemplate('b.c', 'c', '', sharedAttestation);

    await s.tabManager.closeAllTabs();
    await s.tabManager.whenTabsRetired();

    expect(MockPoswWorker.instances.map((w) => w.terminated)).toEqual([1, 1]);
  });

  it('terminates the worker even when deleting the closed tab from IndexedDB fails', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    s.deleteTabSpy.mockRejectedValueOnce(new Error('quota'));

    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(MockPoswWorker.instances[0]?.terminated).toBe(1);
  });

  it('waits for an in-flight event to be appended before deleting the tab rows and terminating the worker', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const worker = MockPoswWorker.instances[0]!;
    worker.hold = true;
    s.recorder.record(keystroke);
    await vi.waitFor(() => expect(worker.held).toHaveLength(1));

    s.tabManager.closeTab(a.id);
    // PoSW がまだ返っていない間は、行の削除も Worker の終了も起きない
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual([]);

    worker.release();
    await s.tabManager.whenTabsRetired();

    expect(log).toEqual([`appended:${a.id}`, `deleted:${a.id}`, 'terminated:0']);
  });

  it('waits for a slow append even after the PoSW queue has drained', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    appendDelayMs = 300;
    s.recorder.record(keystroke);

    // PoSW はすぐ確定するが、append は 300ms 後。この窓で閉じる
    await vi.waitFor(() => expect(a.typingProof.events.length).toBe(2));
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(log).toEqual([`appended:${a.id}`, `deleted:${a.id}`, 'terminated:0']);
    expect(await service.getEvents(a.id)).toEqual([]);
  });

  it('leaves no events row for a tab id whose tabs row is gone after closing a tab with an in-flight event', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const worker = MockPoswWorker.instances[0]!;
    worker.hold = true;
    s.recorder.record(keystroke);
    await vi.waitFor(() => expect(worker.held).toHaveLength(1));

    s.tabManager.closeTab(a.id);
    worker.release();
    await s.tabManager.whenTabsRetired();

    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
  });

  it('keeps recording the tabs that are still open while a closed tab is waiting for its in-flight event', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');
    const workerA = MockPoswWorker.instances[0]!;
    const workerB = MockPoswWorker.instances[1]!;
    workerA.hold = true;
    s.recorder.record(keystroke);
    await vi.waitFor(() => expect(workerA.held).toHaveLength(1));

    s.tabManager.closeTab(a.id);
    await vi.waitFor(() => expect(s.tabManager.getActiveTab()?.id).toBe(b.id));
    s.recorder.record(keystroke);

    // A の計算は止まったまま、B の記録は IndexedDB まで届く
    await vi.waitFor(async () => expect(await service!.getEvents(b.id)).toHaveLength(1));
    expect(log).toEqual([`appended:${b.id}`]);

    workerA.release();
    await s.tabManager.whenTabsRetired();

    expect(workerB.terminated).toBe(0);
    expect(await service.getEvents(b.id)).toHaveLength(1);
    expect(await service.getEvents(a.id)).toEqual([]);
  });
});
