/**
 * SessionStorageService の接続のライフサイクル (#325)。
 *
 * - open が `blocked` を受けたら待たずに `SessionStorageBlockedError` で reject し、遅れて開いた接続は握らない
 * - 別の接続が新しい版を開くと (`versionchange`) 自分の接続を閉じて相手を通し、以後の操作は
 *   `SessionStorageUnavailableError` で reject する
 * - 強制 close (`close` イベント) では 1 回だけ開き直し、成功すれば書き込みを続け、失敗すれば reject する
 * - 接続を失っても `isInitialized()` は true のまま (`TabManager.saveToIndexedDB` が失敗を `synced` に見せない)
 * - リセット用の `close()` は、再オープンの結果を採用せず、失った状態も片付ける
 *
 * vitest は node 環境なので、`indexedDB` はテストごとに新しい `IDBFactory` を差して DB を分離する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import type { StoredEvent, StoredTabData } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import {
  SessionStorageService,
  SessionStorageBlockedError,
  SessionStorageUnavailableError,
  type SessionStorageLostReason,
} from '../SessionStorageService.js';
import { settleWithin } from './idbFaults.js';

const DB_NAME = 'typedcode-session';
/** SessionStorageService の DB_VERSION */
const CURRENT_VERSION = 3;

function makeEvent(sequence: number): StoredEvent {
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
  };
}

function makeTab(id: string, sessionId: string): StoredTabData {
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
  };
}

/** `version` で DB を開き (無ければ空のストア 1 つで作る)、接続をそのまま返す。versionchange には応じない */
function openRaw(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('sessions')) {
        request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** DB を消す。誰かが接続を握ったままなら `blocked` を返す (握っていなければ `deleted`) */
function deleteDatabase(): Promise<'deleted' | 'blocked'> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onblocked = () => resolve('blocked');
    request.onsuccess = () => resolve('deleted');
    request.onerror = () => reject(request.error);
  });
}

/**
 * サービスが握っている接続を強制的に閉じる (サイトデータの削除などの再現。`close` イベントが来る)。
 * fake-indexeddb の型は引数を接続ではなくクラスとして宣言しているので合わせる。
 */
function forceClose(service: SessionStorageService): void {
  const db = (service as unknown as { db: IDBDatabase | null }).db;
  if (!db) throw new Error('service holds no connection');
  forceCloseDatabase(db as unknown as Parameters<typeof forceCloseDatabase>[0]);
}

/** 以後の `indexedDB.open` を、request の error で失敗させる (再オープンの失敗の再現) */
function failNextOpens(): void {
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    const request = {
      error: new DOMException('injected open failure', 'UnknownError'),
      onerror: null as ((ev: Event) => void) | null,
    };
    setTimeout(() => request.onerror?.(new Event('error')), 0);
    return request as unknown as IDBOpenDBRequest;
  });
}

async function openService(): Promise<{
  service: SessionStorageService;
  sessionId: string;
  lost: SessionStorageLostReason[];
}> {
  const service = new SessionStorageService();
  const lost: SessionStorageLostReason[] = [];
  service.setOnConnectionLost((reason) => lost.push(reason));
  await service.initialize();
  const session = await service.createSession();
  return { service, sessionId: session.sessionId, lost };
}

describe('SessionStorageService connection lifecycle (#325)', () => {
  let service: SessionStorageService | null = null;
  const rawConnections: IDBDatabase[] = [];

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    service?.close();
    service = null;
    for (const db of rawConnections.splice(0)) db.close();
    vi.restoreAllMocks();
  });

  describe('blocked open', () => {
    it('initialize rejects with SessionStorageBlockedError while an older connection stays open', async () => {
      rawConnections.push(await openRaw(CURRENT_VERSION - 1));
      service = new SessionStorageService();

      await expect(settleWithin(service.initialize())).rejects.toBeInstanceOf(SessionStorageBlockedError);
    });

    it('closes the connection that opens late after the blocked rejection instead of holding it', async () => {
      const older = await openRaw(CURRENT_VERSION - 1);
      service = new SessionStorageService();
      await expect(settleWithin(service.initialize())).rejects.toBeInstanceOf(SessionStorageBlockedError);

      // 旧接続が閉じると、待っていた open が遅れて success する。それを握っていれば次の delete が blocked になる
      older.close();

      expect(await settleWithin(deleteDatabase())).toBe('deleted');
    });
  });

  describe('versionchange', () => {
    it('closes its connection so that a newer version opened elsewhere is not blocked', async () => {
      const opened = await openService();
      service = opened.service;

      const newer = await settleWithin(openRaw(CURRENT_VERSION + 1));
      rawConnections.push(newer);

      expect(newer.version).toBe(CURRENT_VERSION + 1);
      expect(opened.lost).toEqual(['versionchange']);
    });

    it('rejects appendEvent and saveTab with SessionStorageUnavailableError afterwards', async () => {
      const opened = await openService();
      service = opened.service;
      rawConnections.push(await settleWithin(openRaw(CURRENT_VERSION + 1)));

      await expect(settleWithin(service.appendEvent('tab-1', makeEvent(0)))).rejects.toBeInstanceOf(
        SessionStorageUnavailableError
      );
      await expect(settleWithin(service.saveTab(makeTab('tab-1', opened.sessionId)))).rejects.toMatchObject({
        name: 'SessionStorageUnavailableError',
        reason: 'versionchange',
      });
    });

    it('stays initialized with its session id so that callers report the failed save instead of skipping it', async () => {
      const opened = await openService();
      service = opened.service;
      rawConnections.push(await settleWithin(openRaw(CURRENT_VERSION + 1)));

      expect(service.isInitialized()).toBe(true);
      expect(service.getCurrentSessionId()).toBe(opened.sessionId);
    });
  });

  describe('forced close', () => {
    it('reopens once so that later appendEvent and saveTab are stored and read back', async () => {
      const opened = await openService();
      service = opened.service;

      forceClose(service);
      await settleWithin(service.saveTab(makeTab('tab-1', opened.sessionId)));
      await settleWithin(service.appendEvent('tab-1', makeEvent(0)));

      expect((await service.getEvents('tab-1')).map((e) => e.hash)).toEqual(['hash-0']);
      expect((await service.getTab('tab-1'))?.currentHash).toBe('hash-0');
      expect(opened.lost).toEqual([]);
    });

    it('rejects later writes and reports the lost connection when the reopen fails', async () => {
      const opened = await openService();
      service = opened.service;
      failNextOpens();

      forceClose(service);

      await expect(settleWithin(service.appendEvent('tab-1', makeEvent(0)))).rejects.toMatchObject({
        name: 'SessionStorageUnavailableError',
        reason: 'closed',
      });
      await expect(settleWithin(service.saveTab(makeTab('tab-1', opened.sessionId)))).rejects.toBeInstanceOf(
        SessionStorageUnavailableError
      );
      expect(opened.lost).toEqual(['closed']);
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('intended close()', () => {
    it('does not adopt a reopen that was in flight when close() was called', async () => {
      const opened = await openService();
      service = opened.service;

      forceClose(service);
      service.close();
      // 再オープンの open より後ろに並ぶので、これが終われば再オープンも settle している
      await settleWithin(deleteDatabase());

      await expect(settleWithin(service.getEvents('tab-1'))).rejects.toThrow('Database not initialized');
      expect(opened.lost).toEqual([]);
    });

    it('clears a lost connection so that the service can be initialized again', async () => {
      const opened = await openService();
      service = opened.service;
      // 別のタブのリセット (deleteDatabase) でも versionchange が来て接続を失う
      expect(await settleWithin(deleteDatabase())).toBe('deleted');
      expect(opened.lost).toEqual(['versionchange']);

      service.close();
      await settleWithin(service.initialize());
      const session = await service.createSession();
      await service.saveTab(makeTab('tab-1', session.sessionId));

      expect((await service.getTab('tab-1'))?.sessionId).toBe(session.sessionId);
    });
  });
});
