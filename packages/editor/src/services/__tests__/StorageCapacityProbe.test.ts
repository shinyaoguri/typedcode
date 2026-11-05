/**
 * 起動時の空き容量の試験 (#626)。fake-indexeddb の上で、書けた / 容量切れ / 時間切れの判定と、
 * 試験用 DB を残さないことを見る。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  STORAGE_PROBE_BYTES,
  STORAGE_PROBE_DB_NAME,
  isQuotaExceededError,
  probeStorageCapacity,
  resolveStorageProbeBytes,
} from '../StorageCapacityProbe.js';
import { settleWithin } from './idbFaults.js';

/** 試験で書く量 (テストでは小さくする) */
const BYTES = 64 * 1024;

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map((d) => d.name ?? '');
}

/** 試験用 DB を作り、行を 1 つ書いて閉じる (前回の試験が削除の前に落ちた残骸) */
function leaveLeftover(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(STORAGE_PROBE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('probe');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['probe'], 'readwrite');
      tx.objectStore('probe').put('leftover', 'probe');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const originalPut = IDBObjectStore.prototype.put;

afterEach(() => {
  IDBObjectStore.prototype.put = originalPut;
});

describe('probeStorageCapacity (#626)', () => {
  it('reports ok when the probe data is written and committed', async () => {
    const result = await probeStorageCapacity({ bytes: BYTES, factory: new IDBFactory() });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('reports insufficient when the write fails with QuotaExceededError', async () => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('injected', 'QuotaExceededError');
    };
    const result = await probeStorageCapacity({ bytes: BYTES, factory: new IDBFactory() });
    expect(result.kind).toBe('insufficient');
  });

  it('reports inconclusive rather than insufficient when the write fails for a reason other than quota', async () => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('injected', 'UnknownError');
    };
    const result = await probeStorageCapacity({ bytes: BYTES, factory: new IDBFactory() });
    expect(result).toMatchObject({ kind: 'inconclusive', reason: 'write-failed' });
  });

  it('gives up as inconclusive without reporting insufficient once the time limit passes', async () => {
    const factory = new IDBFactory();
    // 試験用 DB を開いたまま返事をしない接続を置くと、開始時の削除と続く open がその接続の close を待ち続ける
    const holder = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open(STORAGE_PROBE_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('probe');
      request.onsuccess = () => resolve(request.result);
    });

    const result = await settleWithin(probeStorageCapacity({ bytes: BYTES, timeoutMs: 50, factory }), 1_000);
    expect(result).toEqual({ kind: 'inconclusive', reason: 'timeout' });

    // 打ち切った後も、待っていた接続が閉じれば後始末で試験用 DB が消える
    holder.close();
    await expect.poll(() => databaseNames(factory)).not.toContain(STORAGE_PROBE_DB_NAME);
  });

  it('leaves no probe database behind after a successful probe', async () => {
    const factory = new IDBFactory();
    await probeStorageCapacity({ bytes: BYTES, factory });
    expect(await databaseNames(factory)).not.toContain(STORAGE_PROBE_DB_NAME);
  });

  it('leaves no probe database behind after a quota failure', async () => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('injected', 'QuotaExceededError');
    };
    const factory = new IDBFactory();
    await probeStorageCapacity({ bytes: BYTES, factory });
    expect(await databaseNames(factory)).not.toContain(STORAGE_PROBE_DB_NAME);
  });

  it('removes a probe database left over by an earlier interrupted probe before writing', async () => {
    const factory = new IDBFactory();
    await leaveLeftover(factory);
    // 書き込みを失敗させても (= 書く前の段階でも) 残骸は消えている
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('injected', 'UnknownError');
    };
    const deletions: string[] = [];
    const originalDelete = factory.deleteDatabase.bind(factory);
    factory.deleteDatabase = (name: string) => {
      deletions.push(name);
      return originalDelete(name);
    };
    const opens: string[] = [];
    const originalOpen = factory.open.bind(factory);
    factory.open = (name: string, version?: number) => {
      // open の時点で、先に削除を頼んである
      opens.push(`${name}@deletions=${deletions.length}`);
      return originalOpen(name, version);
    };

    await probeStorageCapacity({ bytes: BYTES, factory });
    expect(opens).toEqual([`${STORAGE_PROBE_DB_NAME}@deletions=1`]);
    expect(await databaseNames(factory)).not.toContain(STORAGE_PROBE_DB_NAME);
  });

  it('writes the requested number of bytes', async () => {
    let written = -1;
    IDBObjectStore.prototype.put = function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      written = (value as Blob).size;
      return originalPut.call(this, value, key);
    };
    const bytes = 8 * 1024 * 1024 + 123; // チャンクの境界をまたぐ端数
    await probeStorageCapacity({ bytes, factory: new IDBFactory() });
    expect(written).toBe(bytes);
  });

  it('reports inconclusive when indexedDB is unavailable', async () => {
    const result = await probeStorageCapacity({ bytes: BYTES, factory: undefined });
    expect(result).toEqual({ kind: 'inconclusive', reason: 'unavailable' });
  });
});

describe('resolveStorageProbeBytes (#626)', () => {
  it('defaults to 200MB', () => {
    expect(STORAGE_PROBE_BYTES).toBe(200 * 1024 * 1024);
    expect(resolveStorageProbeBytes()).toBe(STORAGE_PROBE_BYTES);
  });
});

describe('isQuotaExceededError (#626)', () => {
  it('detects QuotaExceededError wrapped in a cause chain', () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    const wrapped = new Error('outer', { cause: new Error('Failed to append event', { cause: quota }) });
    expect(isQuotaExceededError(quota)).toBe(true);
    expect(isQuotaExceededError(wrapped)).toBe(true);
  });

  it('does not treat unrelated errors as quota errors', () => {
    expect(isQuotaExceededError(new Error('x', { cause: new DOMException('y', 'AbortError') }))).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
  });
});
