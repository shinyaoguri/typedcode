/**
 * EventRecorder のテスト。
 *
 * - 記録に失敗したイベントを UI / IndexedDB へ流さない (#284)。
 *   TypingProof.recordEvent は PoSW 計算などで例外が出ても reject せず、`recorded: false` /
 *   `index: -1` を返してチェーンを継続する。以前は index が直前イベントを指していたため、
 *   EventRecorder が直前イベントを今回のイベントとして LogViewer と IndexedDB に二重投入していた。
 * - 起動時ワンショットを、後から作ったタブに流し直す (#405)。
 *   class / assignment は起動時にタブが無いので、recordToAllTabs の時点では載せる先が無い。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { FingerprintComponents, RecordEventInput, WindowSizeData } from '@typedcode/shared';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';
import type { LogViewer } from '../../ui/components/LogViewer.js';

const persistence = vi.hoisted(() => ({
  saveEventToIndexedDB: vi.fn(async () => {}),
  saveTabsToSessionStorage: vi.fn(),
}));

vi.mock('../EventPersistence.js', () => ({
  EventPersistence: class {
    saveEventToIndexedDB = persistence.saveEventToIndexedDB;
    saveTabsToSessionStorage = persistence.saveTabsToSessionStorage;
  },
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { EventRecorder } = await import('../EventRecorder.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (EventRecorder Test)',
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

/**
 * PoSW Web Worker のスタブ (node 環境には Worker が無い)。PoSW 値そのものはこのテストの関心ではない。
 * ProofExporter.drainConsistency.test.ts と同じ流儀。
 */
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

type PoswInternals = { poswManager: { computePoSW: (...args: unknown[]) => Promise<unknown> } };

async function setup() {
  const typingProof = new TypingProof();
  await typingProof.initialize(await computeHash(JSON.stringify(components)), components);
  const tab = { id: 'tab-1', typingProof };
  const tabManager = {
    getActiveTab: () => tab,
    getActiveProof: () => typingProof,
    getAllTabs: () => [tab],
    saveToStorage: vi.fn(),
  } as unknown as TabManager;
  const addLogEntry = vi.fn();
  const logViewer = { isVisible: true, addLogEntry } as unknown as LogViewer;
  // record() は開始時と finally で onStatusUpdate を 1 回ずつ呼ぶ。完了待ちの目印に使う
  const onStatusUpdate = vi.fn();
  const recorder = new EventRecorder({ tabManager, getLogViewer: () => logViewer, onStatusUpdate });
  recorder.setInitialized(true);
  return { typingProof, recorder, addLogEntry, onStatusUpdate };
}

/** 次の computePoSW 呼び出しを 1 回だけ失敗させる (イベントはチェーンに載らない) */
function failNextPoSW(typingProof: TypingProof): void {
  vi.spyOn((typingProof as unknown as PoswInternals).poswManager, 'computePoSW').mockRejectedValueOnce(
    new Error('boom')
  );
}

describe('EventRecorder with a dropped event (#284)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    persistence.saveEventToIndexedDB.mockClear();
    persistence.saveTabsToSessionStorage.mockClear();
    // 失敗は console.error / warn に出る。テスト出力を汚さない
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not re-send the previous event to LogViewer or IndexedDB when record() drops an event', async () => {
    const { typingProof, recorder, addLogEntry, onStatusUpdate } = await setup();

    recorder.record({ type: 'contentChange', inputType: 'insertText', data: 'a' });
    await vi.waitFor(() => expect(onStatusUpdate).toHaveBeenCalledTimes(2));
    expect(persistence.saveEventToIndexedDB).toHaveBeenCalledTimes(1);

    failNextPoSW(typingProof);
    recorder.record({ type: 'contentChange', inputType: 'insertText', data: 'b' });
    await vi.waitFor(() => expect(onStatusUpdate).toHaveBeenCalledTimes(4));

    expect(typingProof.events.length).toBe(1);
    expect(addLogEntry).toHaveBeenCalledTimes(1);
    expect(persistence.saveEventToIndexedDB).toHaveBeenCalledTimes(1);
  });

  it('does not re-send the previous event to LogViewer when recordToAllTabs() drops an event', async () => {
    const { typingProof, recorder, addLogEntry } = await setup();

    await recorder.recordToAllTabs({ type: 'contentChange', inputType: 'insertText', data: 'a' });
    expect(addLogEntry).toHaveBeenCalledTimes(1);

    failNextPoSW(typingProof);
    await recorder.recordToAllTabs({ type: 'contentChange', inputType: 'insertText', data: 'b' });

    expect(typingProof.events.length).toBe(1);
    expect(addLogEntry).toHaveBeenCalledTimes(1);
  });
});

/** 偽 tabManager のタブ一覧を差し替えられる版。TabManager の登録 (tabs.set) を addTab で模す */
async function setupWithTabs(options: { getTermsAcceptedEvent?: () => RecordEventInput | null } = {}) {
  const tabs: TabState[] = [];
  const tabManager = {
    getActiveTab: () => tabs[0] ?? null,
    getActiveProof: () => tabs[0]?.typingProof ?? null,
    getAllTabs: () => [...tabs],
    saveToStorage: vi.fn(),
  } as unknown as TabManager;
  const logViewer = { isVisible: false, addLogEntry: vi.fn() } as unknown as LogViewer;
  const recorder = new EventRecorder({ tabManager, getLogViewer: () => logViewer, ...options });
  recorder.setInitialized(true);

  let nextId = 1;
  async function addTab(): Promise<TabState> {
    const typingProof = new TypingProof();
    await typingProof.initialize(await computeHash(JSON.stringify(components)), components);
    const tab = { id: `tab-${nextId++}`, typingProof } as unknown as TabState;
    tabs.push(tab);
    return tab;
  }
  return { recorder, addTab };
}

function countOf(tab: TabState, type: string): number {
  return tab.typingProof.events.filter((e) => e.type === type).length;
}

function windowResize(width: number): RecordEventInput {
  const data: WindowSizeData = {
    width,
    height: 800,
    innerWidth: width,
    innerHeight: 800,
    devicePixelRatio: 1,
    screenX: 0,
    screenY: 0,
  };
  return { type: 'windowResize', data };
}

const environmentProbe: RecordEventInput = { type: 'environmentProbe', data: null };
const networkStatusChange: RecordEventInput = { type: 'networkStatusChange', data: null };
const screenShareOptOut: RecordEventInput = { type: 'screenShareOptOut', data: null };
const termsAccepted: RecordEventInput = {
  type: 'termsAccepted',
  data: { version: '1.0', timestamp: 0, agreedAt: '2026-01-01T00:00:00.000Z' },
};

describe('EventRecorder session snapshot for tabs created later (#405)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    persistence.saveTabsToSessionStorage.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records a startup one-shot sent while no tab existed exactly once to a tab created afterwards', async () => {
    const { recorder, addTab } = await setupWithTabs();

    await recorder.recordToAllTabs(environmentProbe);
    const tab = await addTab();
    await recorder.recordSessionSnapshotTo(tab);

    expect(countOf(tab, 'environmentProbe')).toBe(1);
    expect(persistence.saveTabsToSessionStorage).toHaveBeenCalledTimes(1);
  });

  it('replays the snapshot only to the given tab, leaving a tab that already had the one-shot at one copy', async () => {
    const { recorder, addTab } = await setupWithTabs();
    const existing = await addTab();

    await recorder.recordToAllTabs(environmentProbe);
    const created = await addTab();
    await recorder.recordSessionSnapshotTo(created);

    expect(countOf(existing, 'environmentProbe')).toBe(1);
    expect(countOf(created, 'environmentProbe')).toBe(1);
  });

  it('replays only the latest windowResize', async () => {
    const { recorder, addTab } = await setupWithTabs();

    await recorder.recordToAllTabs(windowResize(100));
    await recorder.recordToAllTabs(windowResize(200));
    const tab = await addTab();
    await recorder.recordSessionSnapshotTo(tab);

    const resizes = tab.typingProof.events.filter((e) => e.type === 'windowResize');
    expect(resizes.map((e) => (e.data as WindowSizeData).width)).toEqual([200]);
  });

  it('replays termsAccepted first and the snapshot types in a fixed order regardless of arrival order', async () => {
    const { recorder, addTab } = await setupWithTabs({ getTermsAcceptedEvent: () => termsAccepted });

    await recorder.recordToAllTabs(screenShareOptOut);
    await recorder.recordToAllTabs(environmentProbe);
    await recorder.recordToAllTabs(networkStatusChange);
    await recorder.recordToAllTabs(windowResize(100));
    const tab = await addTab();
    await recorder.recordSessionSnapshotTo(tab);

    expect(tab.typingProof.events.map((e) => e.type)).toEqual([
      'termsAccepted',
      'windowResize',
      'networkStatusChange',
      'environmentProbe',
      'screenShareOptOut',
    ]);
  });

  it('does not record termsAccepted again to a tab that already has it', async () => {
    const { recorder, addTab } = await setupWithTabs({ getTermsAcceptedEvent: () => termsAccepted });
    const tab = await addTab();
    await tab.typingProof.recordEvent(termsAccepted);

    await recorder.recordSessionSnapshotTo(tab);

    expect(countOf(tab, 'termsAccepted')).toBe(1);
  });

  it('does not replay events that are not session snapshot types', async () => {
    const { recorder, addTab } = await setupWithTabs();

    await recorder.recordToAllTabs({ type: 'visibilityChange', data: null });
    const tab = await addTab();
    await recorder.recordSessionSnapshotTo(tab);

    expect(tab.typingProof.events).toHaveLength(0);
  });

  it('does not retain a snapshot sent while recording is disabled', async () => {
    const { recorder, addTab } = await setupWithTabs();

    recorder.setEnabled(false);
    await recorder.recordToAllTabs(environmentProbe);
    recorder.setEnabled(true);
    const tab = await addTab();
    await recorder.recordSessionSnapshotTo(tab);

    expect(countOf(tab, 'environmentProbe')).toBe(0);
  });
});
