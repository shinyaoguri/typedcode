/**
 * 教材フォルダを開く・覚える・再開するテスト (#795 / ADR-0051 Decision 9)。
 *
 * fake-indexeddb の上で `FolderHandleStore` を使う。ブラウザの `FileSystemDirectoryHandle` は structured clone
 * できて IndexedDB にそのまま入るが、メモリ上の fake ハンドルは関数を持つので Node の `structuredClone` では
 * 複製できない。そこで、fake-indexeddb が値を複製するときに使う `structuredClone` を、fake ハンドルだけ
 * 同じものを返す (= ブラウザで同じ実体を指すハンドルが返ることの代役) ように差し替える。それ以外の値は
 * 本物の `structuredClone` で複製する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ALL_EDITOR_MODES } from '../../../core/mode.js';
import { sessionDbName, setStorageNamespace } from '../../../core/storageKeys.js';
import { clearCurrentModeData } from '../../../utils/StorageClearHelper.js';
import {
  createMaterialFolderIn,
  pickDirectoryHandle,
  pickMaterialFolder,
  resumeMaterialFolder,
} from '../folderAccess.js';
import { FolderHandleStore, WORKSPACE_DB_NAME } from '../folderHandleStore.js';
import { FakeFileSystem, isFakeHandle } from './fakeDirectoryHandle.js';

const realStructuredClone = globalThis.structuredClone;

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal('structuredClone', (value: unknown, options?: StructuredSerializeOptions) =>
    isFakeHandle(value) ? value : realStructuredClone(value, options)
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function folderWith(files: Record<string, string> = { 'a.md': 'hello' }): FakeFileSystem {
  return new FakeFileSystem('教材', files);
}

describe('FolderHandleStore', () => {
  it('a new store instance returns the folder handle saved by another instance', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    const loaded = await new FolderHandleStore({ indexedDB: factory }).load();
    expect(loaded?.name).toBe('教材');
  });

  it('returns null when no folder has been saved', async () => {
    expect(await new FolderHandleStore({ indexedDB: factory }).load()).toBeNull();
  });

  it('clear forgets the saved folder', async () => {
    const store = new FolderHandleStore({ indexedDB: factory });
    await store.save(folderWith().root());
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('resumeMaterialFolder', () => {
  it('reopens the previous folder from a new store instance when permission is granted', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    if (result.status !== 'opened') throw new Error(`expected opened, got ${result.status}`);
    expect(await result.folder.readText('a.md')).toBe('hello');
  });

  it('returns none when no folder has been saved', async () => {
    expect(await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }))).toEqual({ status: 'none' });
  });

  it('does not read, write or request permission before grant is called when permission is prompt', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    fs.permission = 'prompt';
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    expect({ status: result.status, access: fs.accessCount, requests: fs.requestPermissionCalls }).toEqual({
      status: 'needs-permission',
      access: 0,
      requests: 0,
    });
  });

  it('grant requests readwrite permission and then opens the folder', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    fs.permission = 'prompt';
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    if (result.status !== 'needs-permission') throw new Error(`expected needs-permission, got ${result.status}`);
    const granted = await result.grant();
    if (granted.status !== 'opened') throw new Error(`expected opened, got ${granted.status}`);
    expect([fs.requestPermissionCalls, await granted.folder.readText('a.md')]).toEqual([1, 'hello']);
  });

  it('grant reports denied without touching the folder when the user refuses the permission prompt', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    fs.permission = 'prompt';
    fs.requestResult = 'denied';
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    if (result.status !== 'needs-permission') throw new Error(`expected needs-permission, got ${result.status}`);
    expect([await result.grant(), fs.accessCount]).toEqual([
      { status: 'unavailable', name: '教材', reason: 'denied' },
      0,
    ]);
  });

  it('reports unavailable without touching the folder when permission is denied', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    fs.permission = 'denied';
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    expect([result, fs.accessCount]).toEqual([{ status: 'unavailable', name: '教材', reason: 'denied' }, 0]);
  });

  it('reports the folder as missing when it was removed since the last visit', async () => {
    const fs = folderWith();
    await new FolderHandleStore({ indexedDB: factory }).save(fs.root());
    fs.removeFolder();
    const result = await resumeMaterialFolder(new FolderHandleStore({ indexedDB: factory }));
    expect(result).toMatchObject({ status: 'unavailable', name: '教材', reason: 'missing' });
  });
});

describe('pickMaterialFolder', () => {
  it('opens the picked folder in readwrite mode and remembers it for the next visit', async () => {
    const fs = folderWith();
    const picker = vi.fn(async () => fs.root());
    const result = await pickMaterialFolder({
      showDirectoryPicker: picker,
      store: new FolderHandleStore({ indexedDB: factory }),
    });
    const loaded = await new FolderHandleStore({ indexedDB: factory }).load();
    expect([result.status, picker.mock.calls[0], loaded?.name]).toEqual(['opened', [{ mode: 'readwrite' }], '教材']);
  });

  it('reports cancelled rather than failed when the user cancels the picker', async () => {
    const result = await pickMaterialFolder({
      showDirectoryPicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      store: new FolderHandleStore({ indexedDB: factory }),
    });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('reports failed with the cause when the picker throws something else', async () => {
    const error = new DOMException('blocked', 'SecurityError');
    const result = await pickMaterialFolder({
      showDirectoryPicker: async () => {
        throw error;
      },
      store: new FolderHandleStore({ indexedDB: factory }),
    });
    expect(result).toEqual({ status: 'failed', cause: error });
  });

  it('reports unsupported when no picker is available', async () => {
    expect(await pickMaterialFolder({ store: new FolderHandleStore({ indexedDB: factory }) })).toEqual({
      status: 'unsupported',
    });
  });
});

describe('createMaterialFolderIn', () => {
  it('creates a new folder inside the parent, opens it and remembers it for the next visit', async () => {
    const fs = folderWith();
    const result = await createMaterialFolderIn(fs.root(), '情報基礎', new FolderHandleStore({ indexedDB: factory }));
    const loaded = await new FolderHandleStore({ indexedDB: factory }).load();
    expect([result.status, fs.hasFolder('情報基礎'), loaded?.name]).toEqual(['opened', true, '情報基礎']);
  });

  it('does not reuse a folder that already exists', async () => {
    const fs = folderWith({ '情報基礎/a.md': 'x' });
    const result = await createMaterialFolderIn(fs.root(), '情報基礎', new FolderHandleStore({ indexedDB: factory }));
    expect([result, await new FolderHandleStore({ indexedDB: factory }).load()]).toEqual([
      { status: 'exists', name: '情報基礎' },
      null,
    ]);
  });

  it('treats a file of the same name as existing', async () => {
    const fs = folderWith({ 情報基礎: 'x' });
    const result = await createMaterialFolderIn(fs.root(), '情報基礎', new FolderHandleStore({ indexedDB: factory }));
    expect(result).toEqual({ status: 'exists', name: '情報基礎' });
  });

  it('rejects names that are empty, nested or hidden without creating anything', async () => {
    const fs = folderWith({});
    const store = new FolderHandleStore({ indexedDB: factory });
    const results = await Promise.all(['  ', 'a/b', 'a\\b', '.git'].map((n) => createMaterialFolderIn(fs.root(), n, store)));
    expect([results.map((r) => r.status), fs.hasFolder('a')]).toEqual([
      ['invalid-name', 'invalid-name', 'invalid-name', 'invalid-name'],
      false,
    ]);
  });
});

describe('pickDirectoryHandle', () => {
  it('returns the picked handle without remembering it', async () => {
    const fs = folderWith();
    const result = await pickDirectoryHandle(async () => fs.root());
    expect([result.status, await new FolderHandleStore({ indexedDB: factory }).load()]).toEqual(['picked', null]);
  });

  it('reports cancelled when the user cancels the picker', async () => {
    const result = await pickDirectoryHandle(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(result).toEqual({ status: 'cancelled' });
  });
});

describe('workspace DB and mode reset', () => {
  afterEach(() => {
    setStorageNamespace('casual');
  });

  function memoryStorage(): Storage {
    const map = new Map<string, string>();
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

  it('the workspace DB is never one of the per-mode session DBs', () => {
    const sessionDbs = ALL_EDITOR_MODES.map((mode) => {
      setStorageNamespace(mode);
      return sessionDbName();
    });
    expect(sessionDbs).not.toContain(WORKSPACE_DB_NAME);
  });

  it('resetting any mode keeps the remembered material folder', async () => {
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    await new FolderHandleStore().save(folderWith().root());
    for (const mode of ALL_EDITOR_MODES) {
      setStorageNamespace(mode);
      await clearCurrentModeData();
    }
    expect((await new FolderHandleStore().load())?.name).toBe('教材');
  });
});
