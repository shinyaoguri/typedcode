/**
 * 開いた教材フォルダのハンドルを覚えておく (#795 / ADR-0051 Decision 9)。
 *
 * `FileSystemDirectoryHandle` は structured clone できるので IndexedDB にそのまま入る (localStorage には
 * 入らない)。覚えるのは直近の 1 つだけ。
 *
 * - DB はセッション DB (`typedcode-session*`、`core/storageKeys.ts` の `sessionDbName`) と別の名前にする。
 *   モード別の名前空間に入れないので、「このモードをリセット」(`utils/StorageClearHelper.ts`) が消すのは
 *   セッション DB だけで、ここは消えない。モードのリセットで教材フォルダの記憶まで失わないため
 * - 操作のたびに open して終わったら close する (接続を握り続けない。ほかのタブの版上げや削除を塞がない)
 * - 書き込みは transaction の commit で成功とする (`settleOnCommit`)
 */

import { settleOnCommit } from '../../services/IndexedDBHelper.js';

/** ハンドルを覚える DB の名前。セッション DB (`typedcode-session*`) と重ならない */
export const WORKSPACE_DB_NAME = 'typedcode-author-workspace';

const DB_VERSION = 1;
const STORE = 'folders';
/** 直近に開いたフォルダのキー */
const LAST_FOLDER_KEY = 'last';

export interface FolderHandleStoreOptions {
  /** 使う IndexedDB (テストで fake-indexeddb を差す)。既定は使用時の `globalThis.indexedDB` */
  readonly indexedDB?: IDBFactory;
  /** DB 名 (既定 `WORKSPACE_DB_NAME`) */
  readonly dbName?: string;
}

export class FolderHandleStore {
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;

  constructor(options: FolderHandleStoreOptions = {}) {
    this.factory = options.indexedDB;
    this.dbName = options.dbName ?? WORKSPACE_DB_NAME;
  }

  /** 直近に開いたフォルダとして覚える (前のものは置き換わる) */
  async save(handle: FileSystemDirectoryHandle): Promise<void> {
    await this.withStore('readwrite', (store) => store.put(handle, LAST_FOLDER_KEY));
  }

  /** 覚えているフォルダのハンドル。無ければ null */
  async load(): Promise<FileSystemDirectoryHandle | null> {
    const result = await this.withStore('readonly', (store) => store.get(LAST_FOLDER_KEY));
    return (result as FileSystemDirectoryHandle | undefined) ?? null;
  }

  /** 覚えているフォルダを忘れる (開けなくなったハンドルを捨てるとき) */
  async clear(): Promise<void> {
    await this.withStore('readwrite', (store) => store.delete(LAST_FOLDER_KEY));
  }

  private open(): Promise<IDBDatabase> {
    const factory = this.factory ?? globalThis.indexedDB;
    return new Promise((resolve, reject) => {
      const request = factory.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // ほかのタブが版を上げる / 削除するときは塞がない
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error(`Failed to open ${this.dbName}`));
      request.onblocked = () => reject(new Error(`Opening ${this.dbName} is blocked by another connection`));
    });
  }

  private async withStore(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest
  ): Promise<unknown> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        if (mode === 'readonly') {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error(`Failed to read ${this.dbName}`));
        } else {
          settleOnCommit(transaction, `Failed to write ${this.dbName}`, () => resolve(request.result), reject);
        }
      });
    } finally {
      db.close();
    }
  }
}
