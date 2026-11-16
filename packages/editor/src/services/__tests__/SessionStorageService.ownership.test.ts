/**
 * 所有権を失ったインスタンスの書き込み停止 (#237 PR-3)。
 *
 * Web Locks を使えない経路 (ping → pong) では、凍結中のタブ A を後発の B がすり抜けて同じセッションを
 * `resumeSession` しうる。sessions 行の `instanceId` は最後に再開した 1 インスタンスだけを指すので、
 * これを「どちらが譲るか」の根拠にする (時計に依存しない)。
 * - `verifyOwnership()` は `owner` / `lost` / `unknown` を返し、`lost` でラッチする
 * - 確認を頼んだ後に呼ばれた書き込みは、確認の結果を待ってから transaction を作る (凍結を解かれた直後の
 *   イベントが確認より先に書かれない)
 * - ラッチ後は events / tabs / sessions への書き込みを `SessionOwnershipError` で拒否し、もう一方の記録を汚さない
 *
 * fake-indexeddb を使い、2 つの SessionStorageService を同じ DB に開いて 2 インスタンスを表す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StoredEvent, StoredTabData } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { SessionOwnershipError, SessionStorageService } from '../SessionStorageService.js';

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
    previousHash: null,
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
    filename: `${id}.ts`,
    language: 'typescript',
    content,
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
  };
}

/** A が createSession してタブを書き、B (凍結中の A をすり抜けた後発) が同じセッションを resumeSession した状態 */
async function openTakenOverSession(): Promise<{
  a: SessionStorageService;
  b: SessionStorageService;
  sessionId: string;
}> {
  const a = new SessionStorageService();
  await a.initialize();
  const session = await a.createSession();
  await a.saveTab(makeTab('tab-1', session.sessionId, 'from A'));
  await a.appendEvent('tab-1', makeEvent(0, 'hash-0'));
  const b = new SessionStorageService();
  await b.initialize();
  await b.resumeSession(session.sessionId);
  return { a, b, sessionId: session.sessionId };
}

describe('SessionStorageService ownership after another instance resumed the session (#237)', () => {
  const opened: SessionStorageService[] = [];

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const service of opened.splice(0)) service.close();
    vi.restoreAllMocks();
  });

  async function takenOver() {
    const result = await openTakenOverSession();
    opened.push(result.a, result.b);
    return result;
  }

  it('tells exactly one of the two instances to yield, whichever checks first', async () => {
    const { a, b } = await takenOver();

    const [fromB, fromA] = [await b.verifyOwnership(), await a.verifyOwnership()];
    // 逆順でも同じ (判定は sessions 行だけで決まり、確認の順序や時刻に依存しない)
    const [againA, againB] = [await a.verifyOwnership(), await b.verifyOwnership()];

    expect({ a: fromA, b: fromB }).toEqual({ a: 'lost', b: 'owner' });
    expect({ a: againA, b: againB }).toEqual({ a: 'lost', b: 'owner' });
  });

  it('rejects appends from the instance that lost the session and keeps the events of the owner', async () => {
    const { a, b } = await takenOver();
    await a.verifyOwnership();

    await expect(a.appendEvent('tab-1', makeEvent(1, 'hash-from-A'))).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(b.appendEvent('tab-1', makeEvent(1, 'hash-from-B'))).resolves.toBeUndefined();

    expect((await b.getEvents('tab-1')).map((e) => e.hash)).toEqual(['hash-0', 'hash-from-B']);
  });

  it('holds a write requested right after the ownership check until the check has settled, so it cannot slip in first', async () => {
    const { a, b } = await takenOver();

    // 凍結を解かれた直後: 確認を頼んだのと同じ同期区間で記録の書き込みが走る
    const check = a.verifyOwnership();
    const write = a.appendEvent('tab-1', makeEvent(1, 'hash-from-A'));

    await expect(check).resolves.toBe('lost');
    await expect(write).rejects.toBeInstanceOf(SessionOwnershipError);
    expect((await b.getEvents('tab-1')).map((e) => e.hash)).toEqual(['hash-0']);
  });

  it('rejects tab snapshots, tab deletion and session updates from the instance that lost the session', async () => {
    const { a, b, sessionId } = await takenOver();
    await b.saveTab(makeTab('tab-1', sessionId, 'from B'));
    await a.verifyOwnership();

    await expect(a.saveTab(makeTab('tab-1', sessionId, 'stale A'))).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(a.deleteTab('tab-1')).rejects.toBeInstanceOf(SessionOwnershipError);
    await expect(a.updateTabOrder(['tab-1', 'stale'])).rejects.toBeInstanceOf(SessionOwnershipError);

    expect((await b.getTab('tab-1'))?.content).toBe('from B');
    expect(await b.getEventCount('tab-1')).toBe(1);
    await expect(b.assertOwner()).resolves.toBeUndefined();
  });

  it('keeps accepting writes from the owner after it checked its ownership', async () => {
    const { b } = await takenOver();

    await expect(b.verifyOwnership()).resolves.toBe('owner');

    await expect(b.appendEvent('tab-1', makeEvent(1, 'hash-1'))).resolves.toBeUndefined();
    expect(b.isOwnershipLost()).toBe(false);
  });

  it('treats a session row removed by another instance (which started a fresh session) as lost', async () => {
    const a = new SessionStorageService();
    opened.push(a);
    await a.initialize();
    await a.createSession();
    const b = new SessionStorageService();
    opened.push(b);
    await b.initialize();
    await b.clearSession();
    await b.createSession();

    await expect(a.verifyOwnership()).resolves.toBe('lost');
    await expect(b.verifyOwnership()).resolves.toBe('owner');
  });

  it('answers unknown without latching while there is no session to compare against', async () => {
    const service = new SessionStorageService();
    opened.push(service);
    await service.initialize();

    await expect(service.verifyOwnership()).resolves.toBe('unknown');

    const session = await service.createSession();
    await service.saveTab(makeTab('tab-1', session.sessionId, ''));
    await expect(service.appendEvent('tab-1', makeEvent(0, 'hash-0'))).resolves.toBeUndefined();
  });

  it('notifies the ownership-lost listener once, however many checks find it lost', async () => {
    const { a } = await takenOver();
    const onLost = vi.fn();
    a.setOnOwnershipLost(onLost);

    await a.verifyOwnership();
    await a.verifyOwnership();

    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('still preserves unproven original code after losing the session, since that store is append-only', async () => {
    const { a, b, sessionId } = await takenOver();
    await a.verifyOwnership();

    await a.appendUnprovenContent({
      tabId: 'tab-1',
      sessionId,
      filename: 'tab-1.ts',
      language: 'typescript',
      content: 'code typed in A',
      chainContentLength: 1,
      chainEventCount: 1,
      detectedAt: 1,
    });

    expect((await b.getUnprovenContents('tab-1')).map((r) => r.content)).toEqual(['code typed in A']);
  });
});
