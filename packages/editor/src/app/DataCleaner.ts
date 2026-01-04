/**
 * DataCleaner - データクリア機能
 * アプリケーションデータの完全クリアを担当
 */

import type { AppContext } from '../core/AppContext.js';

/**
 * アプリケーションに関連する全てのデータを完全にクリア
 * - localStorage
 * - sessionStorage
 * - IndexedDB (スクリーンショット等)
 * - Cookies
 * - Service Worker Cache
 */
export async function clearAllAppData(ctx: AppContext): Promise<void> {
  console.log('[TypedCode] Clearing all app data...');

  // 1. localStorage をクリア
  try {
    localStorage.clear();
    console.log('[TypedCode] localStorage cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear localStorage:', e);
  }

  // 2. sessionStorage をクリア
  try {
    sessionStorage.clear();
    console.log('[TypedCode] sessionStorage cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear sessionStorage:', e);
  }

  // 3. IndexedDB をクリア（全てのデータベース）
  try {
    // 既知のデータベース名
    const dbNames = ['typedcode-screenshots'];

    for (const dbName of dbNames) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => {
          console.log(`[TypedCode] IndexedDB "${dbName}" deleted`);
          resolve();
        };
        request.onerror = () => {
          console.warn(`[TypedCode] Failed to delete IndexedDB "${dbName}"`);
          resolve();
        };
        request.onblocked = () => {
          console.warn(`[TypedCode] IndexedDB "${dbName}" deletion blocked`);
          resolve();
        };
      });
    }

    // indexedDB.databases() が利用可能な場合、全てのデータベースを削除
    if ('databases' in indexedDB) {
      const databases = await indexedDB.databases();
      for (const db of databases) {
        if (db.name && db.name.startsWith('typedcode')) {
          await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(db.name!);
            request.onsuccess = () => {
              console.log(`[TypedCode] IndexedDB "${db.name}" deleted`);
              resolve();
            };
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          });
        }
      }
    }
  } catch (e) {
    console.warn('[TypedCode] Failed to clear IndexedDB:', e);
  }

  // 4. Cookies をクリア（このドメインのもの）
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
    console.log('[TypedCode] Cookies cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear cookies:', e);
  }

  // 5. Service Worker Cache をクリア
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const cacheName of cacheNames) {
        await caches.delete(cacheName);
        console.log(`[TypedCode] Cache "${cacheName}" deleted`);
      }
    }
  } catch (e) {
    console.warn('[TypedCode] Failed to clear caches:', e);
  }

  // 6. 画面共有を停止
  try {
    ctx.trackers.screenshot?.dispose();
    console.log('[TypedCode] Screenshot tracker disposed');
  } catch (e) {
    console.warn('[TypedCode] Failed to dispose screenshot tracker:', e);
  }

  console.log('[TypedCode] All app data cleared');
}

/**
 * ストレージデータのみをクリア（リセット機能用）
 */
export function clearStorageData(): void {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }

  // Cookiesをクリア
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
  } catch { /* ignore */ }

  // IndexedDBを削除
  try { indexedDB.deleteDatabase('typedcode-screenshots'); } catch { /* ignore */ }
}
