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
 * スクリーンショット用IndexedDBのみを削除（beforeunload用）
 */
export function deleteScreenshotsDB(): void {
  try {
    indexedDB.deleteDatabase('typedcode-screenshots');
  } catch {
    // ignore
  }
}
