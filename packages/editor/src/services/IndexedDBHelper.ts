/**
 * IndexedDBHelper - IndexedDB操作のヘルパークラス
 *
 * IndexedDBの定型的なトランザクション操作を簡略化するユーティリティ
 */

/**
 * readwrite の transaction を commit で成功、error / abort で失敗として待つ (#543)。
 *
 * request の success は「その操作が transaction の中で通った」だけで、commit される保証ではない
 * (後から abort されると書いた内容は捨てられる)。書き込みは `oncomplete` で成功とし、`onerror` と
 * `onabort` で失敗とする。`onabort` を待たないと、abort された transaction の Promise は永遠に
 * settle しない (保存も export もハングする)。
 *
 * error の後には abort も来るので、失敗の通知は 1 回だけにする (Promise は二重 settle を無視するが、
 * 呼び出し側のログを二重に出さないため)。abort の理由は `transaction.error` に入るが、`abort()` を
 * 明示的に呼んだときは null なので、その場合も Error を作る。
 *
 * `oncomplete` / `onerror` / `onabort` を上書きするので、呼び出し側はこれらを自分で設定しない。
 * request の `onerror` で `preventDefault()` した失敗は transaction を止めないので、ここには来ない。
 */
export function settleOnCommit(
  transaction: IDBTransaction,
  failureMessage: string,
  onCommit: () => void,
  onFailure: (error: Error) => void
): void {
  let failed = false;
  const fail = (event: Event) => {
    if (failed) return;
    failed = true;
    // error は request から bubble してくるので、request の error が理由を持つ
    const target = event.target as { error?: DOMException | null } | null;
    const cause = target?.error ?? transaction.error;
    const reason = cause ? `${cause.name}: ${cause.message}` : 'transaction aborted';
    onFailure(new Error(`${failureMessage}: ${reason}`, cause ? { cause } : undefined));
  };
  transaction.oncomplete = () => {
    if (!failed) onCommit();
  };
  transaction.onerror = fail;
  transaction.onabort = fail;
}

/**
 * IndexedDB操作のヘルパー関数群
 *
 * 書き込み系 (add / put / delete / clear / addBatch / deleteByIndex) は transaction の commit
 * (`oncomplete`) で resolve し、`onerror` / `onabort` で reject する (`settleOnCommit`。#543)。
 */
export class IndexedDBHelper {
  /**
   * 単一のキーでレコードを取得
   */
  static get<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => {
        reject(new Error(`Failed to get from ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  /**
   * レコードを追加（キーが存在する場合はエラー）
   */
  static add<T>(db: IDBDatabase, storeName: string, value: T): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      // key は request の success で控え、commit で返す
      let key: IDBValidKey | undefined;
      settleOnCommit(transaction, `Failed to add to ${storeName}`, () => resolve(key as IDBValidKey), reject);
      const store = transaction.objectStore(storeName);
      const request = store.add(value);

      request.onsuccess = () => {
        key = request.result;
      };
    });
  }

  /**
   * レコードを追加または更新
   */
  static put<T>(db: IDBDatabase, storeName: string, value: T): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      // key は request の success で控え、commit で返す
      let key: IDBValidKey | undefined;
      settleOnCommit(transaction, `Failed to put to ${storeName}`, () => resolve(key as IDBValidKey), reject);
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      request.onsuccess = () => {
        key = request.result;
      };
    });
  }

  /**
   * レコードを削除
   */
  static delete(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      settleOnCommit(transaction, `Failed to delete from ${storeName}`, resolve, reject);
      transaction.objectStore(storeName).delete(key);
    });
  }

  /**
   * ストア内の全レコードを取得
   */
  static getAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to getAll from ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result ?? []);
      };
    });
  }

  /**
   * インデックスを使用して全レコードを取得
   */
  static getAllByIndex<T>(db: IDBDatabase, storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(key);

      request.onerror = () => {
        reject(new Error(`Failed to getAllByIndex from ${storeName}.${indexName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result ?? []);
      };
    });
  }

  /**
   * インデックスを使用してレコード数を取得
   */
  static countByIndex(db: IDBDatabase, storeName: string, indexName: string, key: IDBValidKey): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.count(key);

      request.onerror = () => {
        reject(new Error(`Failed to count from ${storeName}.${indexName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * ストア内の全レコード数を取得
   */
  static count(db: IDBDatabase, storeName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.count();

      request.onerror = () => {
        reject(new Error(`Failed to count from ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * ストア内の全レコードを削除
   */
  static clear(db: IDBDatabase, storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      settleOnCommit(transaction, `Failed to clear ${storeName}`, resolve, reject);
      transaction.objectStore(storeName).clear();
    });
  }

  /**
   * インデックスでカーソルを開き、各レコードに対してコールバックを実行
   */
  static forEachByIndex<T>(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    key: IDBValidKey,
    callback: (value: T) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(IDBKeyRange.only(key));

      request.onerror = () => {
        reject(new Error(`Failed to iterate ${storeName}.${indexName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          callback(cursor.value);
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * インデックスの最新（降順で最初）のレコードを取得
   */
  static getLatestByIndex<T>(db: IDBDatabase, storeName: string, indexName: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(null, 'prev');

      request.onerror = () => {
        reject(new Error(`Failed to get latest from ${storeName}.${indexName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? cursor.value : null);
      };
    });
  }

  /**
   * 複数のレコードを一括追加（同一トランザクション内）
   */
  static addBatch<T>(db: IDBDatabase, storeName: string, values: T[]): Promise<void> {
    if (values.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      settleOnCommit(transaction, `Failed to add batch to ${storeName}`, resolve, reject);
      const store = transaction.objectStore(storeName);

      for (const value of values) {
        store.add(value);
      }
    });
  }

  /**
   * インデックスを使用して該当するレコードを全て削除
   */
  static deleteByIndex(db: IDBDatabase, storeName: string, indexName: string, key: IDBValidKey): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      let deletedCount = 0;
      settleOnCommit(
        transaction,
        `Failed to delete by index from ${storeName}.${indexName}`,
        () => resolve(deletedCount),
        reject
      );
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(IDBKeyRange.only(key));

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        }
      };
    });
  }
}
