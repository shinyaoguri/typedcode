/**
 * ScreenshotStorageService - IndexedDBを使用したスクリーンショット保存
 * スクリーンショット画像のCRUD操作とエクスポート機能を提供
 */

import type { StoredScreenshot, ScreenshotCaptureType, DisplayInfo } from '@typedcode/shared';

const DB_NAME = 'typedcode-screenshots';
const DB_VERSION = 1;
const STORE_NAME = 'screenshots';

export class ScreenshotStorageService {
  private db: IDBDatabase | null = null;
  private initialized = false;

  /**
   * IndexedDBを初期化
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to open database:', request.error);
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        console.log('[ScreenshotStorage] Database initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // インデックス作成
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('eventSequence', 'eventSequence', { unique: false });
          store.createIndex('imageHash', 'imageHash', { unique: false });

          console.log('[ScreenshotStorage] Object store created');
        }
      };
    });
  }

  /**
   * UUIDを生成
   */
  private generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * スクリーンショットを保存
   * @returns 保存されたレコードのID
   */
  async save(screenshot: Omit<StoredScreenshot, 'id'>): Promise<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const id = this.generateId();
    const record: StoredScreenshot = { id, ...screenshot };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.add(record);

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to save screenshot:', request.error);
        reject(new Error('Failed to save screenshot'));
      };

      request.onsuccess = () => {
        console.log('[ScreenshotStorage] Screenshot saved:', id);
        resolve(id);
      };
    });
  }

  /**
   * IDでスクリーンショットを取得
   */
  async getById(id: string): Promise<StoredScreenshot | null> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to get screenshot:', request.error);
        reject(new Error('Failed to get screenshot'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  /**
   * 全スクリーンショットを取得（タイムスタンプ順）
   */
  async getAll(): Promise<StoredScreenshot[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      const request = index.getAll();

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to get all screenshots:', request.error);
        reject(new Error('Failed to get all screenshots'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? []);
      };
    });
  }

  /**
   * 特定のイベントシーケンス以降のスクリーンショットを取得
   */
  async getByEventSequenceRange(
    startSequence: number,
    endSequence?: number
  ): Promise<StoredScreenshot[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('eventSequence');

      const range = endSequence !== undefined
        ? IDBKeyRange.bound(startSequence, endSequence)
        : IDBKeyRange.lowerBound(startSequence);

      const request = index.getAll(range);

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to get screenshots by sequence:', request.error);
        reject(new Error('Failed to get screenshots by sequence'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? []);
      };
    });
  }

  /**
   * スクリーンショットを削除
   */
  async delete(id: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to delete screenshot:', request.error);
        reject(new Error('Failed to delete screenshot'));
      };

      request.onsuccess = () => {
        console.log('[ScreenshotStorage] Screenshot deleted:', id);
        resolve();
      };
    });
  }

  /**
   * 全スクリーンショットを削除
   */
  async clear(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to clear screenshots:', request.error);
        reject(new Error('Failed to clear screenshots'));
      };

      request.onsuccess = () => {
        console.log('[ScreenshotStorage] All screenshots cleared');
        resolve();
      };
    });
  }

  /**
   * 古いスクリーンショットを削除（容量管理）
   * @param maxCount 保持する最大件数
   * @returns 削除された件数
   */
  async pruneOld(maxCount: number): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const all = await this.getAll();
    if (all.length <= maxCount) {
      return 0;
    }

    // タイムスタンプでソート（古い順）
    const sorted = all.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = sorted.slice(0, all.length - maxCount);

    for (const screenshot of toDelete) {
      await this.delete(screenshot.id);
    }

    console.log(`[ScreenshotStorage] Pruned ${toDelete.length} old screenshots`);
    return toDelete.length;
  }

  /**
   * スクリーンショット数を取得
   */
  async count(): Promise<number> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      request.onerror = () => {
        console.error('[ScreenshotStorage] Failed to count screenshots:', request.error);
        reject(new Error('Failed to count screenshots'));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * 全スクリーンショットをBlobとして取得（ZIPエクスポート用）
   * @returns ファイル名とBlobのマップ
   */
  async getAllForExport(): Promise<Map<string, Blob>> {
    const screenshots = await this.getAll();
    const result = new Map<string, Blob>();

    for (const screenshot of screenshots) {
      // ファイル名: screenshot_SEQUENCE_TIMESTAMP.jpg
      const timestamp = new Date(screenshot.createdAt).toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${screenshot.eventSequence.toString().padStart(6, '0')}_${timestamp}.jpg`;
      result.set(filename, screenshot.imageBlob);
    }

    return result;
  }

  /**
   * エクスポート用のマニフェストを生成
   */
  async generateManifest(): Promise<object[]> {
    const screenshots = await this.getAll();

    return screenshots.map((screenshot, index) => {
      const timestamp = new Date(screenshot.createdAt).toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${screenshot.eventSequence.toString().padStart(6, '0')}_${timestamp}.jpg`;

      return {
        index,
        filename,
        imageHash: screenshot.imageHash,
        captureType: screenshot.captureType,
        eventSequence: screenshot.eventSequence,
        timestamp: screenshot.timestamp,
        createdAt: screenshot.createdAt,
        displayInfo: screenshot.displayInfo,
        fileSizeBytes: screenshot.imageBlob.size,
      };
    });
  }

  /**
   * データベース接続を閉じる
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      console.log('[ScreenshotStorage] Database closed');
    }
  }
}
