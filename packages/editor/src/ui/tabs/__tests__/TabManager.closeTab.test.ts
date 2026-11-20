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

  it('waits for the append of an event recorded to every tab before deleting the closed tab rows (#471)', async () => {
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

    // A の append は削除より前に終わり、削除のあとに A の events 行は残らない
    expect(log.indexOf(`appended:${a.id}`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`appended:${a.id}`)).toBeLessThan(log.indexOf(`deleted:${a.id}`));
    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
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
    expect(await service.getEvents(a.id)).toEqual([]);
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
 * 閉じたタブの後始末の途中 (完了待ちの後・削除の最中・削除の後で dispose の前・dispose の後) に
 * 記録の要求が届いても、そのタブの events 行が残らない (#788)。
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
  const holdDuringDelete: Hold = (s, _closedTabId, stop) => {
    const deleteTab = s.deleteTabSpy.getMockImplementation()!;
    s.deleteTabSpy.mockImplementationOnce(async (tabId) => {
      const deleting = deleteTab(tabId);
      stop.reached();
      await stop.release;
      await deleting;
    });
  };
  const holdAfterDeleteBeforeDispose: Hold = (s, _closedTabId, stop) => {
    const deleteTab = s.deleteTabSpy.getMockImplementation()!;
    s.deleteTabSpy.mockImplementationOnce(async (tabId) => {
      await deleteTab(tabId);
      // この後 retireTab は同期で TypingProof.dispose() に進む
      stop.reached();
      await stop.release;
    });
  };
  /** dispose の後: 後始末を止めず、終わってから要求を出す */
  const afterDisposed = null;

  it.each([
    ['right after the closed tab settled, before its rows are deleted', holdAfterSettled],
    ['while the closed tab rows are being deleted', holdDuringDelete],
    ['after the closed tab rows are deleted, before its worker is disposed', holdAfterDeleteBeforeDispose],
    ['after the closed tab worker is disposed', afterDisposed],
  ] as const)('leaves no events row for the closed tab when record requests arrive %s', async (_label, hold) => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');
    await s.tabManager.switchTab(a.id);

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

    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
    // 要求は捨てられず、開いたままの B に載っている (record と recordToAllTabs の 2 件)
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual([1, 2]);
  });
});

/**
 * export 前の保存 (flushToIndexedDB) とタブを閉じる後始末の競合 (#833)。flush の走行は
 * `currentSavePromise` に載らないので、閉じたタブの削除がそれを待たないと、flush が閉じたタブを
 * 書いている最中に閉じたとき、削除の後に tabs 行と events 行が書き戻される。
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

  it('leaves no rows for a tab closed while flushToIndexedDB is writing it, and still saves the open tab', async () => {
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
    // 後始末が「記録の確定を待ち終えて、行を消す段」に来たことを知る
    const settled = gate();
    s.tabManager.setTabSettleBarrier(async (tabId) => {
      await s.recorder.whenTabSettled(tabId);
      if (tabId === a.id) settled.open();
    });

    const flushing = s.tabManager.flushToIndexedDB();
    await writingA.opened;
    s.tabManager.closeTab(a.id);
    await settled.opened;
    // flush が a を書いている間は、a の行を消さずに待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).not.toContain(`deleted:${a.id}`);

    releaseA.open();
    const outcome = await flushing;
    await s.tabManager.whenTabsRetired();

    expect(outcome).toEqual({ idbOk: true, sessionStorageOk: true });
    expect(log.indexOf(`appended:${a.id}`)).toBeLessThan(log.indexOf(`deleted:${a.id}`));
    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
    // 開いたままの B は flush で保存されている
    expect(await service.getTab(b.id)).not.toBeNull();
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual(b.typingProof.events.map((e) => e.sequence));
  });

  it('does not write back a closed tab when flushToIndexedDB starts while its rows are being deleted', async () => {
    const s = await setup();
    service = s.service;
    const a = await s.openTab('a.c');
    const b = await s.openTab('b.c');

    // 行を消し終えた直後 (dispose の前) で後始末を止める
    const deleted = gate();
    const releaseDelete = gate();
    const deleteTab = s.deleteTabSpy.getMockImplementation()!;
    s.deleteTabSpy.mockImplementationOnce(async (tabId) => {
      await deleteTab(tabId);
      deleted.open();
      await releaseDelete.opened;
    });

    s.tabManager.closeTab(a.id);
    await deleted.opened;
    // 削除の途中に flush が始まり、終わる。閉じたタブは this.tabs から外れているので書かない
    const outcome = await s.tabManager.flushToIndexedDB();
    releaseDelete.open();
    await s.tabManager.whenTabsRetired();

    expect(outcome).toEqual({ idbOk: true, sessionStorageOk: true });
    expect(await service.getTab(a.id)).toBeNull();
    expect(await service.getEvents(a.id)).toEqual([]);
    expect(await service.getTab(b.id)).not.toBeNull();
    expect((await service.getEvents(b.id)).map((e) => e.sequence)).toEqual(b.typingProof.events.map((e) => e.sequence));
  });
});
