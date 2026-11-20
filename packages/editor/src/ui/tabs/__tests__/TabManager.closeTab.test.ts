/**
 * 閉じたタブの後始末のテスト (#342 / #317)。
 *
 * - closeTab / closeAllTabs のあと、そのタブの PoSW Worker が terminate される。
 * - exam 以外 (`closedTabPolicy: 'archive'`。#317) は、閉じたタブの tabs 行を `archived: true` + `archivedAt` で
 *   残し、events も残す。計算中のイベントがあれば、その append が済んでから (= チェーンを欠けなく) 閉じたタブとして
 *   書き、その後に Worker を終了する。閉じたタブは IndexedDB からの再開で開いたタブとして戻らない (#145)。
 * - exam (`'delete'`) は従来どおり tabs 行と events 行を消す。`deleteTab` が append より先に走ると、
 *   後から append された events 行がどのタブにも属さない孤児として残る。
 * - 閉じたタブは `reopenArchivedTab` で今のセッションへ開き直せ、記録はチェーンの続きから進む。
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
import { abortTransactionsAfterWriteSuccess } from '../../../services/__tests__/idbFaults.js';

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

/** 起きた順に並べる印 (appended:<tabId> / archived:<tabId> / deleted:<tabId> / terminated:<workerIndex>) */
let log: string[] = [];
/** appendEvent を遅くする (IndexedDB が詰まっている状況)。drain が済んでも append は終わっていない窓を作る */
let appendDelayMs = 0;

/** PoSW Web Worker のスタブ。`hold` の間は返答を溜めて「計算中」を作り、release で返す */
class MockPoswWorker {
  static instances: MockPoswWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  // createPoswWorker が故障の観測 (#701) を付ける。このスタブは error を出さない
  addEventListener(): void {}
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

type Internals = {
  fingerprint: string;
  fingerprintComponents: FingerprintComponents;
};

async function newTabManager() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  // initialize() は sessionStorage を読むので、fingerprint だけ直接入れる
  const internals = tabManager as unknown as Internals;
  internals.fingerprint = await computeHash(JSON.stringify(components));
  internals.fingerprintComponents = components;
  return tabManager;
}

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
  const archiveTab = service.archiveTab.bind(service);
  const archiveTabSpy = vi.spyOn(service, 'archiveTab').mockImplementation(async (tab, events) => {
    await archiveTab(tab, events);
    log.push(`archived:${tab.id}`);
  });

  const tabManager = await newTabManager();

  const recorder = new EventRecorder({ tabManager, getLogViewer: () => null });
  recorder.setInitialized(true);
  tabManager.setTabSettleBarrier((tabId) => recorder.whenTabSettled(tabId));

  /** タブを作り、IndexedDB に tabs 行も置く (実機では保存のデバウンスが置く) */
  async function openTab(filename: string, content = '') {
    const tab = await tabManager.createTab(filename, 'c', content, { sharedAttestation });
    await service.saveTab({ ...storedTab(tab!.id, session.sessionId), content });
    return tab!;
  }

  return { service, session, tabManager, recorder, openTab, deleteTabSpy, archiveTabSpy };
}

/** 保存済みの events の seq と hash (チェーンの並び) */
async function storedChain(service: SessionStorageService, tabId: string) {
  return (await service.getEvents(tabId)).map((e) => ({ sequence: e.sequence, hash: e.hash }));
}

describe('TabManager closing a tab (#342 / #317)', () => {
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('keeps the closed tab as an archived tabs row with archivedAt, its final content and its whole chain', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c', 'int x;');
    await s.openTab('b.c');
    s.recorder.record(keystroke);
    await s.recorder.whenTabSettled(a.id);

    const before = Date.now();
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();
    const after = Date.now();

    const row = await service.getTab(a.id);
    expect(row).toMatchObject({ archived: true, content: 'int x;', filename: 'a.c', sessionId: s.session.sessionId });
    expect(row!.archivedAt).toBeGreaterThanOrEqual(before);
    expect(row!.archivedAt).toBeLessThanOrEqual(after);
    // チェーンはメモリと同じ並びで残り、位置は events 末尾を指す
    const chain = a.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }));
    expect(await storedChain(service, a.id)).toEqual(chain);
    expect(row).toMatchObject({ lastWrittenEventIndex: chain.length - 1, currentHash: chain.at(-1)!.hash });
    expect(s.deleteTabSpy).not.toHaveBeenCalled();
  });

  it('does not restore an archived tab as an open tab when the session is resumed from IndexedDB (#145)', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    const resumed = await newTabManager();
    expect(await resumed.loadFromIndexedDB(s.session.sessionId)).toBe(true);

    expect(resumed.getAllTabs().map((t) => t.id)).toEqual([b.id]);
  });

  it('archives the last remaining tab too, instead of deleting it', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');

    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(s.tabManager.hasAnyTabs()).toBe(false);
    expect((await service.getTab(a.id))?.archived).toBe(true);
    expect(await storedChain(service, a.id)).toHaveLength(a.typingProof.events.length);
  });

  it('archives every tab with its events on closeAllTabs (template import)', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c', 'int a;');
    const b = await s.openTab('b.c', 'int b;');

    await s.tabManager.closeAllTabs();
    await s.tabManager.whenTabsRetired();

    for (const tab of [a, b]) {
      expect(await service.getTab(tab.id)).toMatchObject({ archived: true });
      expect(await storedChain(service, tab.id)).toHaveLength(tab.typingProof.events.length);
    }
    expect((await service.getTab(b.id))?.content).toBe('int b;');
    expect(await service.loadTabs(s.session.sessionId)).toEqual([]);
  });

  it('writes events that were never appended (recorded straight to the proof) into the archive', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    // EventRecorder を通らない記録 (contentSnapshot など) は append されず、保存のデバウンスが書く
    await a.typingProof.recordContentSnapshot('snapshot');
    await a.typingProof.waitForQueueDrain();
    expect(await storedChain(service, a.id)).toHaveLength(0);

    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(await storedChain(service, a.id)).toEqual(
      a.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }))
    );
  });

  it('keeps the previous tabs row and events, and still terminates the worker, when the archive write is aborted', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c', 'int kept;');
    await a.typingProof.recordContentSnapshot('not yet appended');
    await a.typingProof.waitForQueueDrain();
    const fault = abortTransactionsAfterWriteSuccess(['put']);

    try {
      s.tabManager.closeTab(a.id);
      await s.tabManager.whenTabsRetired();
      expect(fault.aborted()).toBeGreaterThan(0);
    } finally {
      fault.restore();
    }

    // 閉じる前の行のまま (archived でない = 削除にも、events だけ増えた状態にも倒れない)
    const row = await service.getTab(a.id);
    expect(row).not.toBeNull();
    expect(row?.archived).toBeUndefined();
    expect(row?.content).toBe('int kept;');
    expect(await storedChain(service, a.id)).toEqual([]);
    expect(log).not.toContain(`archived:${a.id}`);
    expect(MockPoswWorker.instances[0]?.terminated).toBe(1);
  });

  it('refuses to archive once another instance has taken the session over, keeping its rows untouched (#237)', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c', 'int mine;');
    const other = await initSessionStorageServiceForTakeover(s.session.sessionId);
    try {
      expect(await service.verifyOwnership()).toBe('lost');

      s.tabManager.closeTab(a.id);
      await s.tabManager.whenTabsRetired();

      expect((await other.getTab(a.id))?.archived).toBeUndefined();
      expect((await other.getTab(a.id))?.content).toBe('int mine;');
      expect(MockPoswWorker.instances[0]?.terminated).toBe(1);
    } finally {
      other.close();
      // ラッチは再読み込みまで戻らない。共有のシングルトンなので、次のテストのために外す
      (service as unknown as { ownershipLost: boolean }).ownershipLost = false;
    }
  });

  it('waits for an in-flight event to be appended before archiving the tab and terminating the worker', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const worker = MockPoswWorker.instances[0]!;
    worker.hold = true;
    s.recorder.record(keystroke);
    await vi.waitFor(() => expect(worker.held).toHaveLength(1));

    s.tabManager.closeTab(a.id);
    // PoSW がまだ返っていない間は、行の書き込みも Worker の終了も起きない
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(log).toEqual([]);

    worker.release();
    await s.tabManager.whenTabsRetired();

    expect(log).toEqual([`appended:${a.id}`, `archived:${a.id}`, 'terminated:0']);
    // 計算中だったイベントも閉じたタブの記録に入っている
    expect((await storedChain(service, a.id)).map((e) => e.sequence)).toEqual([0, 1]);
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

    expect(log).toEqual([`appended:${a.id}`, `archived:${a.id}`, 'terminated:0']);
    expect((await storedChain(service, a.id)).map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('waits for the append of an event recorded to every tab before archiving the closed tab (#471)', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');
    appendDelayMs = 300;
    const recordedToAll = s.recorder.recordToAllTabs({ type: 'focusChange', data: { focused: false } });

    // PoSW は全タブで確定したが、append は 300ms 後。この窓で A を閉じる
    await vi.waitFor(() => {
      expect(a.typingProof.events.length).toBe(2);
      expect(b.typingProof.events.length).toBe(2);
    });
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();
    await recordedToAll;

    // A の append は閉じたタブの書き込みより前に終わり、A のチェーンは欠番なく残る
    expect(log.indexOf(`appended:${a.id}`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`appended:${a.id}`)).toBeLessThan(log.indexOf(`archived:${a.id}`));
    expect((await service.getTab(a.id))?.archived).toBe(true);
    expect((await storedChain(service, a.id)).map((e) => e.sequence)).toEqual([0, 1]);
    // 開いたままの B には全タブ記録のイベントが入っている
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual([1]);
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
    expect((await storedChain(service, a.id)).map((e) => e.sequence)).toEqual([0, 1]);
  });
});

/** 同じセッションを別インスタンスが再開した状態を作る (所有権の喪失。#237) */
async function initSessionStorageServiceForTakeover(sessionId: string): Promise<SessionStorageService> {
  const { SessionStorageService: Service } = await import('../../../services/SessionStorageService.js');
  const other = new Service();
  await other.initialize();
  await other.resumeSession(sessionId);
  return other;
}

describe('TabManager closing a tab in exam mode (closedTabPolicy: delete)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('exam');
    log = [];
    appendDelayMs = 0;
    MockPoswWorker.instances = [];
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(), setItem: vi.fn() });
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

  it('deletes the tabs row and events of a closed tab instead of archiving them', async () => {
    const s = await setup();
    service = s.service;
    s.tabManager.setClosedTabPolicy('delete');
    const a = await s.openTab('a.c');
    s.recorder.record(keystroke);
    await s.recorder.whenTabSettled(a.id);

    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
    expect(s.archiveTabSpy).not.toHaveBeenCalled();
  });

  it('waits for an in-flight event to be appended before deleting the rows, leaving no orphan events', async () => {
    const s = await setup();
    service = s.service;
    s.tabManager.setClosedTabPolicy('delete');
    const a = await s.openTab('a.c');
    const worker = MockPoswWorker.instances[0]!;
    worker.hold = true;
    s.recorder.record(keystroke);
    await vi.waitFor(() => expect(worker.held).toHaveLength(1));

    s.tabManager.closeTab(a.id);
    worker.release();
    await s.tabManager.whenTabsRetired();

    expect(log).toEqual([`appended:${a.id}`, `deleted:${a.id}`, 'terminated:0']);
    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
  });

  it('terminates the worker even when deleting the closed tab from IndexedDB fails', async () => {
    const s = await setup();
    service = s.service;
    s.tabManager.setClosedTabPolicy('delete');
    const a = await s.openTab('a.c');
    s.deleteTabSpy.mockRejectedValueOnce(new Error('quota'));

    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();

    expect(MockPoswWorker.instances[0]?.terminated).toBe(1);
  });

  it('does not reopen anything while the exam tab lock is on', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();
    s.tabManager.setExamLock(true);

    expect(await s.tabManager.reopenArchivedTab(a.id)).toBeNull();
    expect((await service.getTab(a.id))?.archived).toBe(true);
  });
});

/** 手で開ける止め具 (タイマーに頼らず順序を作る)。`open()` を呼ぶまで `opened` は解決しない */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * 閉じたタブの後始末の途中 (完了待ちの後・書き込みの最中・書き込みの後で dispose の前・dispose の後) に
 * 記録の要求が届いても、閉じたタブの events は閉じた時点のチェーンのまま増えない (#788 / #317)。
 *
 * 防いでいるのは、closeTab が retireTab を始める前に同期でタブを `tabs` から外すこと
 * (TabManager.closeTab)。EventRecorder の記録の入口 (record / recordToTabId / recordToAllTabs) は
 * 対象のタブを呼ばれた時点で TabManager から引くので、外した後の要求は閉じたタブに届かない。
 * 外す前に始まった記録は `whenTabSettled` が待つ (上の #342 のケース)。
 */
describe('TabManager closing a tab while record requests keep arriving (#788)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    log = [];
    appendDelayMs = 0;
    MockPoswWorker.instances = [];
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(), setItem: vi.fn() });
    vi.spyOn(TabManager.prototype, 'saveToStorage').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  type Setup = Awaited<ReturnType<typeof setup>>;
  /** 後始末をその地点で止める。返す `reached` はそこに来たら開き、`release` を開くまで先へ進まない */
  type Hold = (s: Setup, closedTabId: string, stop: { reached: () => void; release: Promise<void> }) => void;

  const holdAfterSettled: Hold = (s, closedTabId, stop) => {
    s.tabManager.setTabSettleBarrier(async (tabId) => {
      await s.recorder.whenTabSettled(tabId);
      if (tabId !== closedTabId) return;
      stop.reached();
      await stop.release;
    });
  };
  const holdDuringArchive: Hold = (s, _closedTabId, stop) => {
    const archiveTab = s.archiveTabSpy.getMockImplementation()!;
    s.archiveTabSpy.mockImplementationOnce(async (tab, events) => {
      const archiving = archiveTab(tab, events);
      stop.reached();
      await stop.release;
      await archiving;
    });
  };
  const holdAfterArchiveBeforeDispose: Hold = (s, _closedTabId, stop) => {
    const archiveTab = s.archiveTabSpy.getMockImplementation()!;
    s.archiveTabSpy.mockImplementationOnce(async (tab, events) => {
      await archiveTab(tab, events);
      // この後 retireTab は同期で TypingProof.dispose() に進む
      stop.reached();
      await stop.release;
    });
  };
  /** dispose の後: 後始末を止めず、終わってから要求を出す */
  const afterDisposed = null;

  it.each([
    ['right after the closed tab settled, before it is archived', holdAfterSettled],
    ['while the closed tab is being archived', holdDuringArchive],
    ['after the closed tab is archived, before its worker is disposed', holdAfterArchiveBeforeDispose],
    ['after the closed tab worker is disposed', afterDisposed],
  ] as const)('adds no event to the closed tab when record requests arrive %s', async (_label, hold) => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');
    await s.tabManager.switchTab(a.id);
    const chainAtClose = a.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }));

    const reached = gate();
    const release = gate();
    if (hold) hold(s, a.id, { reached: reached.open, release: release.opened });

    expect(s.tabManager.closeTab(a.id)).toBe(true);
    if (hold) {
      await reached.opened;
    } else {
      await s.tabManager.whenTabsRetired();
      expect(MockPoswWorker.instances[0]?.terminated).toBe(1);
    }

    // 閉じたタブ宛てになりうる入口から記録を要求する
    s.recorder.record(keystroke);
    s.recorder.recordToTabId(a.id, { type: 'focusChange', data: { focused: false } });
    const recordedToAll = s.recorder.recordToAllTabs({ type: 'focusChange', data: { focused: true } });

    release.open();
    await s.tabManager.whenTabsRetired();
    await recordedToAll;
    await s.recorder.whenTabSettled(a.id);
    await s.recorder.whenTabSettled(b.id);

    expect((await service.getTab(a.id))?.archived).toBe(true);
    expect(await storedChain(service, a.id)).toEqual(chainAtClose);
    // 要求は捨てられず、開いたままの B に載っている (record と recordToAllTabs の 2 件)
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual([1, 2]);
  });
});

/**
 * export 前の保存 (flushToIndexedDB) とタブを閉じる後始末の競合 (#833)。flush の走行は
 * `currentSavePromise` に載らないので、閉じたタブの書き込みがそれを待たないと、flush が閉じたタブを
 * 書いている最中に閉じたとき、閉じたタブの行が flush の (archived の無い) 行で上書きされ、復元で蘇る。
 */
describe('TabManager closing a tab while flushToIndexedDB is saving (#833)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    log = [];
    appendDelayMs = 0;
    MockPoswWorker.instances = [];
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(), setItem: vi.fn() });
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

  it('archives a tab closed while flushToIndexedDB is writing it only after the flush, and still saves the open tab', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');

    // flush が a の events を書く手前で止める
    const writingA = gate();
    const releaseA = gate();
    const appendEvent = vi.mocked(s.service.appendEvent).getMockImplementation()!;
    vi.mocked(s.service.appendEvent).mockImplementation(async (tabId, event) => {
      if (tabId === a.id) {
        writingA.open();
        await releaseA.opened;
      }
      await appendEvent(tabId, event);
    });
    // 後始末が「記録の確定を待ち終えて、行を書く段」に来たことを知る
    const settled = gate();
    s.tabManager.setTabSettleBarrier(async (tabId) => {
      await s.recorder.whenTabSettled(tabId);
      if (tabId === a.id) settled.open();
    });

    const flushing = s.tabManager.flushToIndexedDB();
    await writingA.opened;
    s.tabManager.closeTab(a.id);
    await settled.opened;
    // flush が a を書いている間は、閉じたタブとして書かずに待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).not.toContain(`archived:${a.id}`);

    releaseA.open();
    const outcome = await flushing;
    await s.tabManager.whenTabsRetired();

    expect(outcome).toEqual({ idbOk: true, sessionStorageOk: true });
    expect(log.indexOf(`appended:${a.id}`)).toBeLessThan(log.indexOf(`archived:${a.id}`));
    // flush の行で上書きされず、閉じたタブのまま (復元の対象に入らない)
    expect((await service.getTab(a.id))?.archived).toBe(true);
    expect((await service.loadTabs(s.session.sessionId)).map((t) => t.id)).toEqual([b.id]);
    expect(await storedChain(service, a.id)).toEqual(
      a.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }))
    );
    // 開いたままの B は flush で保存されている
    expect(await service.getTab(b.id)).not.toBeNull();
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual(b.typingProof.events.map((e) => e.sequence));
  });

  it('does not write back a closed tab as open when flushToIndexedDB starts while it is being archived', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');

    // 閉じたタブとして書き終えた直後 (dispose の前) で後始末を止める
    const archived = gate();
    const releaseArchive = gate();
    const archiveTab = s.archiveTabSpy.getMockImplementation()!;
    s.archiveTabSpy.mockImplementationOnce(async (tab, events) => {
      await archiveTab(tab, events);
      archived.open();
      await releaseArchive.opened;
    });

    s.tabManager.closeTab(a.id);
    await archived.opened;
    // 書き込みの途中に flush が始まり、終わる。閉じたタブは this.tabs から外れているので書かない
    const outcome = await s.tabManager.flushToIndexedDB();
    releaseArchive.open();
    await s.tabManager.whenTabsRetired();

    expect(outcome).toEqual({ idbOk: true, sessionStorageOk: true });
    expect((await service.getTab(a.id))?.archived).toBe(true);
    expect(await service.getTab(b.id)).not.toBeNull();
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual(b.typingProof.events.map((e) => e.sequence));
  });
});

/**
 * 閉じたタブを開き直す (#317)。同じ中身とチェーンのタブが今のセッションの開いたタブとしてアクティブになり、
 * 記録はチェーンの続きから進む。前のセッションのタブも開き直せる。書き直しに失敗したら閉じたタブのまま残る。
 */
describe('TabManager reopening a closed tab (#317)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    log = [];
    appendDelayMs = 0;
    MockPoswWorker.instances = [];
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(), setItem: vi.fn() });
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

  async function closeWithTyping(s: Awaited<ReturnType<typeof setup>>, content: string) {
    const a = await s.openTab('a.c', content);
    await s.openTab('b.c');
    await s.tabManager.switchTab(a.id);
    s.recorder.record(keystroke);
    await s.recorder.whenTabSettled(a.id);
    const chain = a.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }));
    s.tabManager.closeTab(a.id);
    await s.tabManager.whenTabsRetired();
    return { a, chain };
  }

  it('reopens a closed tab as the active open tab with the same content and chain, and lists it no more', async () => {
    const s = await setup();
    service = s.service;
    const { a, chain } = await closeWithTyping(s, 'a');
    expect((await s.tabManager.listArchivedTabs()).map((t) => t.id)).toEqual([a.id]);

    const reopened = await s.tabManager.reopenArchivedTab(a.id);

    expect(reopened?.id).toBe(a.id);
    expect(s.tabManager.getActiveTab()?.id).toBe(a.id);
    expect(reopened!.model.getValue()).toBe('a');
    expect(reopened!.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }))).toEqual(chain);
    const row = await service.getTab(a.id);
    expect(row?.archived).toBeUndefined();
    expect(row?.archivedAt).toBeUndefined();
    expect(await s.tabManager.listArchivedTabs()).toEqual([]);
    expect((await service.loadTabs(s.session.sessionId)).map((t) => t.id).sort()).toEqual(
      s.tabManager
        .getAllTabs()
        .map((t) => t.id)
        .sort()
    );
  });

  it('continues the reopened chain from the stored tail when recording resumes', async () => {
    const s = await setup();
    service = s.service;
    const { a, chain } = await closeWithTyping(s, '');
    await s.tabManager.reopenArchivedTab(a.id);

    s.recorder.record(keystroke);
    await s.recorder.whenTabSettled(a.id);

    const stored = await service.getEvents(a.id);
    expect(stored.map((e) => e.sequence)).toEqual([...chain.map((e) => e.sequence), chain.length]);
    expect(stored.at(-1)!.previousHash).toBe(chain.at(-1)!.hash);
  });

  it('reopens a tab closed in a previous session into the current session', async () => {
    const s = await setup();
    service = s.service;
    const { a, chain } = await closeWithTyping(s, 'a');
    const next = await service.createSession();

    const resumed = await newTabManager();
    const reopened = await resumed.reopenArchivedTab(a.id);

    expect(reopened?.model.getValue()).toBe('a');
    expect(reopened!.typingProof.events.map((e) => ({ sequence: e.sequence, hash: e.hash }))).toEqual(chain);
    expect((await service.getTab(a.id))?.sessionId).toBe(next.sessionId);
    expect((await service.loadTabs(next.sessionId)).map((t) => t.id)).toEqual([a.id]);
  });

  it('returns null and leaves the row archived when the reopened row cannot be written', async () => {
    const s = await setup();
    service = s.service;
    const { a } = await closeWithTyping(s, '');
    vi.spyOn(service, 'saveTab').mockRejectedValueOnce(new Error('quota'));
    const workersBefore = MockPoswWorker.instances.length;

    expect(await s.tabManager.reopenArchivedTab(a.id)).toBeNull();

    expect(s.tabManager.getTab(a.id)).toBeNull();
    expect((await service.getTab(a.id))?.archived).toBe(true);
    // 組み立てたタブの Worker は残さない
    expect(MockPoswWorker.instances.slice(workersBefore).map((w) => w.terminated)).toEqual([1]);
  });

  it('does not reopen an open tab or an unknown id', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');

    expect(await s.tabManager.reopenArchivedTab(a.id)).toBeNull();
    expect(await s.tabManager.reopenArchivedTab('missing')).toBeNull();
    expect(s.tabManager.getAllTabs()).toHaveLength(1);
  });

  it('builds only one tab when the same closed tab is reopened twice at once', async () => {
    const s = await setup();
    service = s.service;
    const { a } = await closeWithTyping(s, '');

    const [first, second] = await Promise.all([
      s.tabManager.reopenArchivedTab(a.id),
      s.tabManager.reopenArchivedTab(a.id),
    ]);

    expect([first, second].filter((t) => t !== null)).toHaveLength(1);
    expect(s.tabManager.getAllTabs().filter((t) => t.id === a.id)).toHaveLength(1);
  });
});
