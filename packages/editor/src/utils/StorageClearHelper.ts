/**
 * StorageClearHelper - ストレージクリア処理のヘルパー
 *
 * アプリケーションのストレージ（localStorage, sessionStorage, IndexedDB, Cookies）を
 * クリアするための共通ユーティリティ関数を提供
 */

/** 既知のIndexedDBデータベース名 */
const INDEXED_DB_NAMES = ['typedcode-screenshots', 'typedcode-session'] as const;

/**
 * Cookiesをクリア
 */
function clearCookies(): void {
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 同期的にストレージをクリア（即座にリロードする場合用）
 *
 * localStorage, sessionStorage, Cookies, IndexedDBの削除リクエストを発行
 * 注: IndexedDBの削除は非同期だが、リクエストは即座に発行される
 */
export function clearStorageSync(): void {
  // localStorage
  try {
    localStorage.clear();
  } catch {
    // ignore
  }

  // sessionStorage
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }

  // Cookies
  clearCookies();

  // IndexedDB（削除リクエストを発行、完了は待たない）
  for (const dbName of INDEXED_DB_NAMES) {
    try {
      indexedDB.deleteDatabase(dbName);
    } catch {
      // ignore
    }
  }
}

/**
 * 非同期でストレージを完全にクリア
 *
 * すべてのストレージの削除完了を待ち、Service Worker Cacheも削除
 *
 * @param options.skipServiceWorkerCache - Service Worker Cacheの削除をスキップ
 * @returns Promise<void>
 */
export async function clearStorageAsync(options?: {
  skipServiceWorkerCache?: boolean;
}): Promise<void> {
  console.log('[StorageClearHelper] Clearing all storage...');

  // localStorage
  try {
    localStorage.clear();
    console.log('[StorageClearHelper] localStorage cleared');
  } catch (e) {
    console.warn('[StorageClearHelper] Failed to clear localStorage:', e);
  }

  // sessionStorage
  try {
    sessionStorage.clear();
    console.log('[StorageClearHelper] sessionStorage cleared');
  } catch (e) {
    console.warn('[StorageClearHelper] Failed to clear sessionStorage:', e);
  }

  // Cookies
  try {
    clearCookies();
    console.log('[StorageClearHelper] Cookies cleared');
  } catch (e) {
    console.warn('[StorageClearHelper] Failed to clear cookies:', e);
  }

  // IndexedDB（完了を待つ）
  try {
    for (const dbName of INDEXED_DB_NAMES) {
      await deleteIndexedDB(dbName);
    }

    // indexedDB.databases() が利用可能な場合、typedcode-* のDBを全て削除
    if ('databases' in indexedDB) {
      const databases = await indexedDB.databases();
      for (const db of databases) {
        if (db.name && db.name.startsWith('typedcode')) {
          await deleteIndexedDB(db.name);
        }
      }
    }
  } catch (e) {
    console.warn('[StorageClearHelper] Failed to clear IndexedDB:', e);
  }

  // Service Worker Cache
  if (!options?.skipServiceWorkerCache) {
    try {
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const cacheName of cacheNames) {
          await caches.delete(cacheName);
          console.log(`[StorageClearHelper] Cache "${cacheName}" deleted`);
        }
      }
    } catch (e) {
      console.warn('[StorageClearHelper] Failed to clear caches:', e);
    }
  }

  console.log('[StorageClearHelper] All storage cleared');
}

/**
 * IndexedDBを削除（完了を待つ）
 */
async function deleteIndexedDB(dbName: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => {
      console.log(`[StorageClearHelper] IndexedDB "${dbName}" deleted`);
      resolve();
    };
    request.onerror = () => {
      console.warn(`[StorageClearHelper] Failed to delete IndexedDB "${dbName}"`);
      resolve();
    };
    request.onblocked = () => {
      console.warn(`[StorageClearHelper] IndexedDB "${dbName}" deletion blocked`);
      resolve();
    };
  });
}

/**
 * スクリーンショット用IndexedDBのみを削除（beforeunload用）
 */
export function deleteScreenshotsDB(): void {
  try {
    indexedDB.deleteDatabase('typedcode-screenshots');
  } catch {
    // ignore
  }
}
