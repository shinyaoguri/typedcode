/**
 * EventRecorder の「記録に失敗したイベントを UI / IndexedDB へ流さない」テスト (#284)。
 *
 * TypingProof.recordEvent は PoSW 計算などで例外が出ても reject せず、`recorded: false` /
 * `index: -1` を返してチェーンを継続する。以前は index が直前イベントを指していたため、
 * EventRecorder が直前イベントを今回のイベントとして LogViewer と IndexedDB に二重投入していた。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { FingerprintComponents } from '@typedcode/shared';
import type { TabManager } from '../../ui/tabs/TabManager.js';
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
