/**
 * IndexedDBHelper - IndexedDB操作のヘルパークラス
 *
 * IndexedDBの定型的なトランザクション操作を簡略化するユーティリティ
 */

/**
 * IndexedDB操作のヘルパー関数群
 */
export class IndexedDBHelper {
  /**
   * 単一のキーでレコードを取得
   */
  static get<T>(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey
  ): Promise<T | null> {
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
  static add<T>(
    db: IDBDatabase,
    storeName: string,
    value: T
  ): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.add(value);

      request.onerror = () => {
        reject(new Error(`Failed to add to ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * レコードを追加または更新
   */
  static put<T>(
    db: IDBDatabase,
    storeName: string,
    value: T
  ): Promise<IDBValidKey> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      request.onerror = () => {
        reject(new Error(`Failed to put to ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * レコードを削除
   */
  static delete(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onerror = () => {
        reject(new Error(`Failed to delete from ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * ストア内の全レコードを取得
   */
  static getAll<T>(
    db: IDBDatabase,
    storeName: string
  ): Promise<T[]> {
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
  static getAllByIndex<T>(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    key: IDBValidKey
  ): Promise<T[]> {
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
  static countByIndex(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    key: IDBValidKey
  ): Promise<number> {
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
  static count(
    db: IDBDatabase,
    storeName: string
  ): Promise<number> {
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
  static clear(
    db: IDBDatabase,
    storeName: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => {
        reject(new Error(`Failed to clear ${storeName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
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
  static getLatestByIndex<T>(
    db: IDBDatabase,
    storeName: string,
    indexName: string
  ): Promise<T | null> {
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
  static addBatch<T>(
    db: IDBDatabase,
    storeName: string,
    values: T[]
  ): Promise<void> {
    if (values.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      transaction.onerror = () => {
        reject(new Error(`Failed to add batch to ${storeName}: ${transaction.error?.message}`));
      };

      transaction.oncomplete = () => {
        resolve();
      };

      for (const value of values) {
        store.add(value);
      }
    });
  }

  /**
   * インデックスを使用して該当するレコードを全て削除
   */
  static deleteByIndex(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    key: IDBValidKey
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(IDBKeyRange.only(key));
      let deletedCount = 0;

      request.onerror = () => {
        reject(new Error(`Failed to delete by index from ${storeName}.${indexName}: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          resolve(deletedCount);
        }
      };
    });
  }
}
