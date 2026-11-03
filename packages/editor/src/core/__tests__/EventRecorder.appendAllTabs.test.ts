/**
 * recordToAllTabs / recordSessionSnapshotTo で記録したイベントも、record() と同じく
 * IndexedDB へ 1 件ずつ append される (#471)。
 *
 * 以前は recordToTab が保存を何も呼ばず、TabManager のデバウンス保存だけが頼りだった。
 * 直後に record() の打鍵が続くと、後続の seq だけが先に append されて events に欠番ができ、
 * そのまま落ちると復元したチェーンが欠番で切れた (editor の不変条件 5)。
 *
 * 本物の EventRecorder / EventPersistence / SessionStorageService (fake-indexeddb) を使い、
 * 境界の PoSW Worker だけスタブする。TabManager のデバウンス保存は走らせない (saveToStorage は no-op)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { FingerprintComponents } from '@typedcode/shared';
import { setStorageNamespace } from '../storageKeys.js';
import { initSessionStorageService, type SessionStorageService } from '../../services/SessionStorageService.js';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { EventRecorder } = await import('../EventRecorder.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (EventRecorder appendAllTabs Test)',
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

/** PoSW Web Worker のスタブ (node 環境には Worker が無い) */
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

const keystroke = { type: 'contentChange', inputType: 'insertText', data: 'a' } as const;
const focusChange = { type: 'focusChange', data: { focused: false } } as const;

async function newTab(id: string): Promise<TabState> {
  const typingProof = new TypingProof();
  await typingProof.initialize(await computeHash(JSON.stringify(components)), components);
  return { id, typingProof } as unknown as TabState;
}

async function setup() {
  const service: SessionStorageService = await initSessionStorageService();
  await service.createSession();

  const tab = await newTab('tab-1');
  const tabManager = {
    getActiveTab: () => tab,
    getActiveProof: () => tab.typingProof,
    getAllTabs: () => [tab],
    saveToStorage: vi.fn(),
  } as unknown as TabManager;
  const recorder = new EventRecorder({ tabManager, getLogViewer: () => null });
  recorder.setInitialized(true);
  return { service, tab, recorder };
}

describe('EventRecorder persists events recorded to every tab (#471)', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.stubGlobal('Worker', MockPoswWorker);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves no sequence gap in IndexedDB when record() follows recordToAllTabs', async () => {
    const s = await setup();
    service = s.service;

    // seq 0 (打鍵) → seq 1 (全タブ記録の focusChange) → seq 2 (打鍵)。デバウンス保存は走らない
    s.recorder.record(keystroke);
    await s.recorder.recordToAllTabs(focusChange);
    s.recorder.record(keystroke);
    await s.recorder.whenTabSettled(s.tab.id);

    expect(s.tab.typingProof.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    const stored = await service.getEvents(s.tab.id);
    expect(stored.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('appends the session-snapshot events replayed into a newly created tab', async () => {
    const s = await setup();
    service = s.service;
    await s.recorder.recordToAllTabs({ type: 'networkStatusChange', data: null });

    const created = await newTab('tab-2');
    await s.recorder.recordSessionSnapshotTo(created);

    expect(created.typingProof.events.map((e) => e.sequence)).toEqual([0]);
    const stored = await service.getEvents(created.id);
    expect(stored.map((e) => e.sequence)).toEqual([0]);
  });
});
