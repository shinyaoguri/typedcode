/**
 * 閉じたタブの保存 (#317)。
 *
 * - `archiveTab` は 1 つの transaction で、無いイベントを足し、tabs 行を `archived: true` で置き、位置を揃える。
 *   失敗・中断・二重インスタンスの拒否では何も書かず、閉じる前の行と events が残る (削除へは倒れない)
 * - 閉じたタブは `loadTabs` (復元の対象) と `hasExistingSession` (復旧ダイアログを出すか) から外れる
 * - `archiveSessionTabs` は前のセッションの開いているタブを 1 transaction で閉じたタブにする
 * - `listArchivedTabs` はどのセッションの閉じたタブも、閉じた時刻の新しい順に返す
 *
 * fake-indexeddb を使い、本物の SessionStorageService を通す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StoredEvent, StoredTabData } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { EventChainConflictError, SessionOwnershipError, SessionStorageService } from '../SessionStorageService.js';
import { abortTransactionsAfterWriteSuccess, settleWithin } from './idbFaults.js';

function makeEvent(sequence: number, hash: string): StoredEvent {
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
    hash,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  };
}

function makeTab(id: string, sessionId: string, content: string): StoredTabData {
  return {
    id,
    sessionId,
    filename: `${id}.c`,
    language: 'c',
    content,
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
  };
}

const chain = (n: number): StoredEvent[] => Array.from({ length: n }, (_, i) => makeEvent(i, `hash-${i}`));

describe('SessionStorageService closed tabs (#317)', () => {
  let service: SessionStorageService;
  let sessionId: string;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service = new SessionStorageService();
    await service.initialize();
    sessionId = (await service.createSession()).sessionId;
  });

  afterEach(() => {
    service.close();
    vi.restoreAllMocks();
  });

  /** 開いているタブを 1 つ置き、最初の `stored` 件の events を append しておく */
  async function openTabWithEvents(id: string, stored: number): Promise<void> {
    await service.saveTab(makeTab(id, sessionId, 'before close'));
    for (const event of chain(stored)) await service.appendEvent(id, event);
  }

  it('keeps the archived tabs row with archived/archivedAt and adds only the missing events, in order', async () => {
    await openTabWithEvents('a', 2);

    await service.archiveTab({ ...makeTab('a', sessionId, 'final'), archived: true, archivedAt: 5000 }, chain(4));

    const row = await service.getTab('a');
    expect(row).toMatchObject({ archived: true, archivedAt: 5000, content: 'final' });
    // 位置は events 末尾に揃う (tabs 行の位置は -1 のままでも、重ねて読むと末尾になる)
    expect(row).toMatchObject({ lastWrittenEventIndex: 3, currentHash: 'hash-3' });
    expect((await service.getEvents('a')).map((e) => e.hash)).toEqual(['hash-0', 'hash-1', 'hash-2', 'hash-3']);
  });

  it('excludes archived tabs from loadTabs and from hasExistingSession', async () => {
    await openTabWithEvents('a', 1);
    await openTabWithEvents('b', 1);
    expect(await service.hasExistingSession()).toBe(true);

    await service.archiveTab({ ...makeTab('a', sessionId, ''), archived: true, archivedAt: 1 }, chain(1));
    expect((await service.loadTabs(sessionId)).map((t) => t.id)).toEqual(['b']);
    expect(await service.hasExistingSession()).toBe(true);

    await service.archiveTab({ ...makeTab('b', sessionId, ''), archived: true, archivedAt: 2 }, chain(1));
    expect(await service.loadTabs(sessionId)).toEqual([]);
    expect(await service.hasExistingSession()).toBe(false);
    // 行も events も残っている (閉じただけ)
    expect(await service.getTab('a')).not.toBeNull();
    expect(await service.getEvents('b')).toHaveLength(1);
  });

  it('writes nothing and keeps the previous rows when the archive transaction is aborted at commit', async () => {
    await openTabWithEvents('a', 2);
    const fault = abortTransactionsAfterWriteSuccess(['put']);
    try {
      await expect(
        settleWithin(
          service.archiveTab({ ...makeTab('a', sessionId, 'final'), archived: true, archivedAt: 5000 }, chain(4))
        )
      ).rejects.toThrow(/Failed to archive tab/);
      expect(fault.aborted()).toBeGreaterThan(0);
    } finally {
      fault.restore();
    }

    const row = await service.getTab('a');
    expect(row?.archived).toBeUndefined();
    expect(row?.content).toBe('before close');
    // 足すはずだった events も入っていない (行と events の片方だけが変わらない)
    expect((await service.getEvents('a')).map((e) => e.hash)).toEqual(['hash-0', 'hash-1']);
  });

  it('rejects with EventChainConflictError and writes nothing when a stored event has a different hash', async () => {
    await openTabWithEvents('a', 2);
    const diverged = [makeEvent(0, 'hash-0'), makeEvent(1, 'other-1'), makeEvent(2, 'other-2')];

    await expect(
      service.archiveTab({ ...makeTab('a', sessionId, 'final'), archived: true, archivedAt: 5000 }, diverged)
    ).rejects.toBeInstanceOf(EventChainConflictError);

    expect((await service.getTab('a'))?.archived).toBeUndefined();
    expect((await service.getEvents('a')).map((e) => e.hash)).toEqual(['hash-0', 'hash-1']);
  });

  it('refuses to archive after ownership was lost to another instance', async () => {
    await openTabWithEvents('a', 1);
    const other = new SessionStorageService();
    await other.initialize();
    await other.resumeSession(sessionId);
    expect(await service.verifyOwnership()).toBe('lost');

    await expect(
      service.archiveTab({ ...makeTab('a', sessionId, 'final'), archived: true, archivedAt: 5000 }, chain(2))
    ).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(service.archiveSessionTabs(sessionId, 1)).rejects.toBeInstanceOf(SessionOwnershipError);

    expect((await other.getTab('a'))?.archived).toBeUndefined();
    expect(await other.getEvents('a')).toHaveLength(1);
    other.close();
  });

  it('archives every open tab of a session with archivedAt and leaves its events and other sessions alone', async () => {
    await openTabWithEvents('a', 2);
    await openTabWithEvents('b', 1);
    await service.archiveTab({ ...makeTab('b', sessionId, ''), archived: true, archivedAt: 10 }, chain(1));
    const next = await service.createSession();
    await service.saveTab(makeTab('c', next.sessionId, ''));

    expect(await service.archiveSessionTabs(sessionId, 7000)).toBe(1);

    expect(await service.getTab('a')).toMatchObject({ archived: true, archivedAt: 7000 });
    // 既に閉じていたタブの時刻は変えない
    expect(await service.getTab('b')).toMatchObject({ archived: true, archivedAt: 10 });
    expect((await service.getTab('c'))?.archived).toBeUndefined();
    expect(await service.getEvents('a')).toHaveLength(2);
  });

  it('lists closed tabs of every session, newest first, with their event counts', async () => {
    await openTabWithEvents('a-old', 3);
    await service.archiveTab({ ...makeTab('a-old', sessionId, ''), archived: true, archivedAt: 100 }, chain(3));
    const next = await service.createSession();
    await service.saveTab(makeTab('z-new', next.sessionId, ''));
    await service.archiveTab({ ...makeTab('z-new', next.sessionId, ''), archived: true, archivedAt: 200 }, chain(1));
    await service.saveTab(makeTab('open', next.sessionId, ''));

    const listed = await service.listArchivedTabs();

    expect(listed).toEqual([
      { id: 'z-new', sessionId: next.sessionId, filename: 'z-new.c', language: 'c', archivedAt: 200, eventCount: 1 },
      { id: 'a-old', sessionId, filename: 'a-old.c', language: 'c', archivedAt: 100, eventCount: 3 },
    ]);
  });

  it('removes closed tabs only with clearSession (the "delete permanently" choice)', async () => {
    await openTabWithEvents('a', 2);
    await service.archiveTab({ ...makeTab('a', sessionId, ''), archived: true, archivedAt: 1 }, chain(2));

    await service.clearSession();

    expect(await service.listArchivedTabs()).toEqual([]);
    expect(await service.getEvents('a')).toEqual([]);
  });
});
