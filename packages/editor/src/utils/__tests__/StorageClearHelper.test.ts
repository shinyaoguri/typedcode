/**
 * StorageClearHelper のテスト (#323)。
 *
 * fake-indexeddb 上で、リセットが「現在のモードの session DB と、そのモードのキーだけ」を消し、
 * 自分の接続を閉じて削除の完了を待つことを固定する。vitest は node 環境なので、`indexedDB` と
 * `localStorage` / `sessionStorage` はテストごとに差す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { getSessionStorageService } from '../../services/SessionStorageService.js';
import { clearCurrentModeData, deleteDatabaseAndWait } from '../StorageClearHelper.js';

function makeStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** 空の DB を作って閉じる (別モードのセッション DB の代役)。 */
async function createDb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
  });
}

async function dbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '').sort();
}

describe('clearCurrentModeData', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal(
      'localStorage',
      makeStorage({
        'typedcode-terms-accepted': 'yes',
        'typedcode-locale': 'ja',
        'typedcode-theme': 'dark',
        'typedcode-exam-packages': 'casual-exam-cache',
        'typedcode-class-problems': 'casual-class-cache',
        'typedcode-exam-packages-exam': 'exam-cache',
        'typedcode-class-problems-assignment': 'assignment-cache',
      })
    );
    vi.stubGlobal(
      'sessionStorage',
      makeStorage({
        'typedcode-tabs': 'casual-tabs',
        'typedcode-session-active': 'true',
        'typedcode-tabs-assignment': 'assignment-tabs',
        'typedcode-session-active-exam': 'true',
      })
    );
    setStorageNamespace('casual');
  });

  afterEach(() => {
    getSessionStorageService().close();
    vi.unstubAllGlobals();
  });

  it('deletes only the current mode session db and leaves the other modes dbs', async () => {
    await createDb('typedcode-session-assignment');
    await createDb('typedcode-session-exam');
    await getSessionStorageService().initialize(); // typedcode-session (casual) を開いたままにする
    expect(await dbNames()).toEqual(['typedcode-session', 'typedcode-session-assignment', 'typedcode-session-exam']);

    await clearCurrentModeData();

    expect(await dbNames()).toEqual(['typedcode-session-assignment', 'typedcode-session-exam']);
  });

  it('removes only the current mode keys and keeps the other modes and the mode-independent keys', async () => {
    await clearCurrentModeData();

    expect(localStorage.getItem('typedcode-exam-packages')).toBeNull();
    expect(localStorage.getItem('typedcode-class-problems')).toBeNull();
    expect(sessionStorage.getItem('typedcode-tabs')).toBeNull();
    expect(sessionStorage.getItem('typedcode-session-active')).toBeNull();

    expect(localStorage.getItem('typedcode-exam-packages-exam')).toBe('exam-cache');
    expect(localStorage.getItem('typedcode-class-problems-assignment')).toBe('assignment-cache');
    expect(sessionStorage.getItem('typedcode-tabs-assignment')).toBe('assignment-tabs');
    expect(sessionStorage.getItem('typedcode-session-active-exam')).toBe('true');
    expect(localStorage.getItem('typedcode-terms-accepted')).toBe('yes');
    expect(localStorage.getItem('typedcode-locale')).toBe('ja');
    expect(localStorage.getItem('typedcode-theme')).toBe('dark');
  });

  it('targets the suffixed db and keys when the current mode is not casual', async () => {
    setStorageNamespace('exam');
    await createDb('typedcode-session');
    await createDb('typedcode-session-exam');

    await clearCurrentModeData();

    expect(await dbNames()).toEqual(['typedcode-session']);
    expect(localStorage.getItem('typedcode-exam-packages-exam')).toBeNull();
    expect(sessionStorage.getItem('typedcode-session-active-exam')).toBeNull();
    expect(localStorage.getItem('typedcode-exam-packages')).toBe('casual-exam-cache');
    expect(sessionStorage.getItem('typedcode-tabs')).toBe('casual-tabs');
  });

  it('closes its own connection first so the deletion is not blocked by itself', async () => {
    const service = getSessionStorageService();
    await service.initialize();
    expect(service.isInitialized()).toBe(true);

    await expect(clearCurrentModeData()).resolves.toBeUndefined();

    expect(service.isInitialized()).toBe(false);
    expect(await dbNames()).toEqual([]);
  });

  it('rejects and keeps the keys when the db deletion is blocked by another open connection', async () => {
    const other = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('typedcode-session', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

    await expect(clearCurrentModeData()).rejects.toThrow(/blocked/);

    expect(sessionStorage.getItem('typedcode-tabs')).toBe('casual-tabs');
    expect(localStorage.getItem('typedcode-exam-packages')).toBe('casual-exam-cache');
    other.close();
  });
});

describe('deleteDatabaseAndWait', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  it('resolves only after the database is actually gone', async () => {
    await createDb('typedcode-session');
    await deleteDatabaseAndWait('typedcode-session');
    expect(await dbNames()).toEqual([]);
  });

  it('resolves for a database that does not exist', async () => {
    await expect(deleteDatabaseAndWait('typedcode-session-never-created')).resolves.toBeUndefined();
  });
});
