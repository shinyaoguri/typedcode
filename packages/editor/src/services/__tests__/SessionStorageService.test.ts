/**
 * SessionStorageService のテスト (#327)。
 *
 * fake-indexeddb 上で、永続化の「いまの振る舞い」を固定する。
 * - 保存 → 復元の往復で内容と順序が戻る
 * - 同じ (tabId, eventIndex) の再 append は reject されず、events は 1 件のまま (ConstraintError の吸収。
 *   EventRecorder と TabManager.saveToIndexedDB が同じイベントを二重に書くため、いまは正常系。
 *   書き込み経路を一本化する #414 / #237 で変えるときに、このテストが赤くなる)
 * - clearSession / deleteTab が対象のストアを消す (#317 で変えるときに赤くなる)
 *
 * vitest は node 環境なので、`indexedDB` はテストごとに新しい `IDBFactory` を差して DB を分離する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StoredEvent, StoredTabData, StoredScreenshotData, TabSwitchEvent } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { SessionStorageService } from '../SessionStorageService.js';

function makeEvent(sequence: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    sequence,
    timestamp: sequence * 10,
    type: 'contentChange',
    inputType: 'insertText',
    data: `char-${sequence}`,
    rangeOffset: sequence,
    rangeLength: 0,
    range: null,
    previousHash: sequence === 0 ? null : `hash-${sequence - 1}`,
    posw: { iterations: 1, nonce: `nonce-${sequence}`, intermediateHash: `mid-${sequence}`, computeTimeMs: 1 },
    hash: `hash-${sequence}`,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
    ...overrides,
  };
}

function makeTab(id: string, sessionId: string, overrides: Partial<StoredTabData> = {}): StoredTabData {
  return {
    id,
    sessionId,
    filename: `${id}.ts`,
    language: 'typescript',
    content: '',
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
    ...overrides,
  };
}

function makeScreenshot(id: string, sessionId: string): StoredScreenshotData {
  return {
    id,
    sessionId,
    imageHash: `img-${id}`,
    imageBlob: new Blob(['x'], { type: 'image/jpeg' }),
    captureType: 'periodic',
    timestamp: 1,
    createdAt: 1,
    displayInfo: { width: 1, height: 1, devicePixelRatio: 1 },
    eventSequence: 0,
  };
}

/** createSession 後の service を作る。 */
async function openService(): Promise<{ service: SessionStorageService; sessionId: string }> {
  const service = new SessionStorageService();
  await service.initialize();
  const session = await service.createSession();
  return { service, sessionId: session.sessionId };
}

describe('SessionStorageService', () => {
  let service: SessionStorageService | null = null;

  beforeEach(() => {
    // テストごとに IndexedDB を丸ごと差し替えて分離する
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    // サービスの console.log / error を黙らせる (失敗時の診断は throw 側で出る)
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    vi.restoreAllMocks();
  });

  describe('save / load round trip', () => {
    it('loadTabs returns the saved tab with its content intact', async () => {
      const opened = await openService();
      service = opened.service;
      const tab = makeTab('tab-1', opened.sessionId, { content: 'let x = 1;', language: 'javascript' });

      await service.saveTab(tab);

      expect(await service.loadTabs(opened.sessionId)).toEqual([tab]);
    });

    it('getEvents returns appended events with their payloads intact', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      const events = [makeEvent(0), makeEvent(1), makeEvent(2)];

      for (const event of events) await service.appendEvent('tab-1', event);

      expect(await service.getEvents('tab-1')).toEqual(events);
    });

    it('getEvents returns events in sequence order even when they were appended out of order', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));

      for (const sequence of [2, 0, 3, 1]) await service.appendEvent('tab-1', makeEvent(sequence));

      expect((await service.getEvents('tab-1')).map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    });

    it('appendEvent advances the tab lastWrittenEventIndex and currentHash to the latest event', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));

      await service.appendEvent('tab-1', makeEvent(0));
      await service.appendEvent('tab-1', makeEvent(1));

      const tab = await service.getTab('tab-1');
      expect(tab?.lastWrittenEventIndex).toBe(1);
      expect(tab?.currentHash).toBe('hash-1');
    });

    it('getEvents keeps each tab separate', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-a', opened.sessionId));
      await service.saveTab(makeTab('tab-b', opened.sessionId));

      await service.appendEvent('tab-a', makeEvent(0));
      await service.appendEvent('tab-a', makeEvent(1));
      await service.appendEvent('tab-b', makeEvent(0));

      expect((await service.getEvents('tab-a')).length).toBe(2);
      expect((await service.getEvents('tab-b')).length).toBe(1);
    });

    it('appendEvent rejects before createSession because there is no session to write under', async () => {
      service = new SessionStorageService();
      await service.initialize();

      await expect(service.appendEvent('tab-1', makeEvent(0))).rejects.toThrow('Database or session not initialized');
    });

    it('a second service on the same database sees the data a first one saved (reload recovery)', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));
      service.close();

      const reloaded = new SessionStorageService();
      service = reloaded;
      await reloaded.initialize();
      const latest = await reloaded.getLatestSession();

      expect(latest?.sessionId).toBe(opened.sessionId);
      expect((await reloaded.loadTabs(opened.sessionId)).map((t) => t.id)).toEqual(['tab-1']);
      expect((await reloaded.getEvents('tab-1')).length).toBe(1);
    });
  });

  describe('duplicate append (ConstraintError absorption)', () => {
    it('appending the same (tabId, eventIndex) again resolves instead of rejecting', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));

      await expect(service.appendEvent('tab-1', makeEvent(0))).resolves.toBeUndefined();
    });

    it('appending the same (tabId, eventIndex) again leaves exactly one event stored', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));
      await service.appendEvent('tab-1', makeEvent(0));

      expect(await service.getEventCount('tab-1')).toBe(1);
      expect((await service.getEvents('tab-1')).length).toBe(1);
    });

    it('the first write wins: a duplicate with a different hash does not overwrite the stored event', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0, { hash: 'first' }));
      await service.appendEvent('tab-1', makeEvent(0, { hash: 'second' }));

      expect((await service.getEvents('tab-1'))[0]?.hash).toBe('first');
    });

    it('a duplicate append still moves the tab currentHash to the duplicate event hash', async () => {
      // いまの挙動の固定: events への add は弾かれるが、同じトランザクション内の tabs 更新は走る
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0, { hash: 'first' }));
      await service.appendEvent('tab-1', makeEvent(0, { hash: 'second' }));

      expect((await service.getTab('tab-1'))?.currentHash).toBe('second');
    });

    it('the same eventIndex on a different tab is not a duplicate', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-a', opened.sessionId));
      await service.saveTab(makeTab('tab-b', opened.sessionId));

      await service.appendEvent('tab-a', makeEvent(0));
      await service.appendEvent('tab-b', makeEvent(0));

      expect(await service.getEventCount('tab-a')).toBe(1);
      expect(await service.getEventCount('tab-b')).toBe(1);
    });
  });

  describe('clearSession', () => {
    it('empties sessions, tabs, events, tabSwitches and screenshots together', async () => {
      const opened = await openService();
      service = opened.service;
      const switchEvent: TabSwitchEvent = {
        timestamp: 1,
        fromTabId: null,
        toTabId: 'tab-1',
        fromFilename: null,
        toFilename: 'tab-1.ts',
      };
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));
      await service.saveTabSwitch(switchEvent);
      await service.saveScreenshot(makeScreenshot('shot-1', opened.sessionId));

      await service.clearSession();

      expect(await service.getLatestSession()).toBeNull();
      expect(await service.loadTabs(opened.sessionId)).toEqual([]);
      expect(await service.getEventCount('tab-1')).toBe(0);
      expect(await service.getTabSwitches(opened.sessionId)).toEqual([]);
      expect(await service.getScreenshotCount()).toBe(0);
    });

    it('forgets the current session id', async () => {
      const opened = await openService();
      service = opened.service;

      await service.clearSession();

      expect(service.getCurrentSessionId()).toBeNull();
    });
  });

  describe('deleteTab', () => {
    it('removes the tab record', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));

      await service.deleteTab('tab-1');

      expect(await service.getTab('tab-1')).toBeNull();
    });

    it('removes that tab events', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));
      await service.appendEvent('tab-1', makeEvent(1));

      await service.deleteTab('tab-1');

      expect(await service.getEvents('tab-1')).toEqual([]);
    });

    it('leaves the other tabs and their events untouched', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));
      await service.saveTab(makeTab('tab-2', opened.sessionId));
      await service.appendEvent('tab-1', makeEvent(0));
      await service.appendEvent('tab-2', makeEvent(0));

      await service.deleteTab('tab-1');

      expect((await service.loadTabs(opened.sessionId)).map((t) => t.id)).toEqual(['tab-2']);
      expect(await service.getEventCount('tab-2')).toBe(1);
    });

    it('leaves the session record in place', async () => {
      const opened = await openService();
      service = opened.service;
      await service.saveTab(makeTab('tab-1', opened.sessionId));

      await service.deleteTab('tab-1');

      expect((await service.getLatestSession())?.sessionId).toBe(opened.sessionId);
    });
  });

  describe('storage namespace', () => {
    it('a non-casual mode writes to its own database, apart from casual', async () => {
      const casual = await openService();
      service = casual.service;
      await service.saveTab(makeTab('tab-1', casual.sessionId));
      service.close();

      setStorageNamespace('exam');
      const exam = new SessionStorageService();
      service = exam;
      await exam.initialize();

      expect(await exam.getLatestSession()).toBeNull();
    });
  });
});
