/**
 * IndexedDBHelper の書き込み系は transaction の commit で成功とする (#543)。
 *
 * request の success は commit の保証ではない。success の後に transaction が abort されると、書いた内容は
 * 捨てられる。そのとき resolve すると「保存できた」と誤って伝え、`onabort` を待たないと永遠に settle しない
 * (保存も export もハングする)。fake-indexeddb で success の後に abort させて、reject することを見る。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { IndexedDBHelper, settleOnCommit } from '../IndexedDBHelper.js';
import { abortTransactionsAfterWriteSuccess, settleWithin, type InjectedAbort } from './idbFaults.js';

interface Item {
  id: string;
  group: string;
}

const STORE = 'items';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = new IDBFactory().open('helper-test', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('group', 'group');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('IndexedDBHelper writes settle on commit (#543)', () => {
  let db: IDBDatabase;
  let injected: InjectedAbort | null = null;

  beforeEach(async () => {
    // deleteByIndex が使う。node 環境には無い
    globalThis.IDBKeyRange ??= FakeIDBKeyRange as unknown as typeof IDBKeyRange;
    db = await openDb();
  });

  afterEach(() => {
    injected?.restore();
    injected = null;
    db.close();
  });

  it('add resolves with the key once the transaction commits', async () => {
    await expect(IndexedDBHelper.add<Item>(db, STORE, { id: 'a', group: 'g' })).resolves.toBe('a');
  });

  it('add rejects when the transaction aborts after the request succeeded', async () => {
    injected = abortTransactionsAfterWriteSuccess(['add']);

    await expect(settleWithin(IndexedDBHelper.add<Item>(db, STORE, { id: 'a', group: 'g' }))).rejects.toThrow(
      /Failed to add to items/
    );
    expect(injected.aborted()).toBe(1);
  });

  it('put rejects when the transaction aborts after the request succeeded', async () => {
    injected = abortTransactionsAfterWriteSuccess(['put']);

    await expect(settleWithin(IndexedDBHelper.put<Item>(db, STORE, { id: 'a', group: 'g' }))).rejects.toThrow(
      /Failed to put to items/
    );
    expect(injected.aborted()).toBe(1);
  });

  it('delete rejects when the transaction aborts after the request succeeded', async () => {
    await IndexedDBHelper.put<Item>(db, STORE, { id: 'a', group: 'g' });
    injected = abortTransactionsAfterWriteSuccess(['delete']);

    await expect(settleWithin(IndexedDBHelper.delete(db, STORE, 'a'))).rejects.toThrow(/Failed to delete from items/);
  });

  it('clear rejects when the transaction aborts after the request succeeded', async () => {
    injected = abortTransactionsAfterWriteSuccess(['clear']);

    await expect(settleWithin(IndexedDBHelper.clear(db, STORE))).rejects.toThrow(/Failed to clear items/);
  });

  it('deleteByIndex resolves with the deleted count once the transaction commits', async () => {
    await IndexedDBHelper.put<Item>(db, STORE, { id: 'a', group: 'g' });
    await IndexedDBHelper.put<Item>(db, STORE, { id: 'b', group: 'g' });
    await IndexedDBHelper.put<Item>(db, STORE, { id: 'c', group: 'other' });

    await expect(IndexedDBHelper.deleteByIndex(db, STORE, 'group', 'g')).resolves.toBe(2);
    expect(await IndexedDBHelper.getAll<Item>(db, STORE)).toEqual([{ id: 'c', group: 'other' }]);
  });
});

describe('settleOnCommit (#543)', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openDb();
  });

  afterEach(() => {
    db.close();
  });

  /** transaction を settleOnCommit で待ち、onCommit / onFailure の呼ばれ方を集める */
  function watch(transaction: IDBTransaction): Promise<{ commits: number; failures: Error[] }> {
    const seen = { commits: 0, failures: [] as Error[] };
    settleOnCommit(
      transaction,
      'Failed to write',
      () => {
        seen.commits += 1;
      },
      (error) => {
        seen.failures.push(error);
      }
    );
    // complete / abort のどちらかで終わった後、遅れて来る通知が無いことまで見るため 1 タスク待つ
    return new Promise((resolve) => {
      transaction.addEventListener('complete', () => setTimeout(() => resolve(seen), 0));
      transaction.addEventListener('abort', () => setTimeout(() => resolve(seen), 0));
    });
  }

  it('fails with a message of its own when abort() leaves transaction.error null', async () => {
    const transaction = db.transaction([STORE], 'readwrite');
    const seen = watch(transaction);
    // 待ちの request があると、その AbortError が先に error として bubble するので、request を出さずに abort する
    transaction.abort();

    const { commits, failures } = await seen;
    expect(commits).toBe(0);
    expect(failures.map((e) => e.message)).toEqual(['Failed to write: transaction aborted']);
  });

  it('reports a request error followed by the abort it causes only once, with the request error as the reason', async () => {
    const transaction = db.transaction([STORE], 'readwrite');
    const seen = watch(transaction);
    const store = transaction.objectStore(STORE);
    store.add({ id: 'a', group: 'g' });
    store.add({ id: 'a', group: 'g' }); // ConstraintError → error が bubble し、続けて abort

    const { commits, failures } = await seen;
    expect(commits).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/^Failed to write: ConstraintError/);
  });
});
