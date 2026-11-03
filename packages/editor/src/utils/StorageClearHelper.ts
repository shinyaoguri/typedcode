/**
 * StorageClearHelper - 設定メニューの「このモードをリセット」(en は Reset This Mode) の消去処理 (#323)
 *
 * 消すのは**現在のモードのデータだけ**: そのモードの session IndexedDB と、`core/storageKeys.ts` で
 * モード別になっている localStorage / sessionStorage のキー。ほかのモードのデータ、モード共通のキー
 * (規約同意・表示言語・テーマ)、Cookie には触れない。リンクを開くだけで消える経路は無く
 * (URL の `?reset` は撤去済み)、この関数は確認ダイアログの確定からだけ呼ばれる。
 */

import { modeLocalStorageKeys, modeSessionStorageKeys, sessionDbName } from '../core/storageKeys.js';
import { getSessionStorageService } from '../services/SessionStorageService.js';

/**
 * IndexedDB を削除し、完了 (`onsuccess`) を待つ。
 *
 * 他の接続が開いたままだと削除は `onblocked` になり、完了しない。待ち続けても進まないので失敗として
 * reject する (呼び出し側は、消えていないまま先へ進まない)。
 */
export function deleteDatabaseAndWait(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(`deleteDatabase(${name}) threw`));
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`deleteDatabase(${name}) failed`));
    request.onblocked = () => reject(new Error(`deleteDatabase(${name}) is blocked by another open connection`));
  });
}

function removeKeys(storage: Storage, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore (ストレージが使えない環境では消すものも無い)
    }
  }
}

/**
 * 現在のモードのデータを消す。
 *
 * 1. 自分の接続 (`SessionStorageService`) を閉じる。開いたままだと自分の接続で削除が blocked になる
 * 2. session DB の削除の完了を待つ
 * 3. 削除に成功したら、モード別の localStorage / sessionStorage のキーを消す。DB が消えていないのに
 *    キーだけ消すと、残った DB と食い違うので、失敗したときはキーを残す (reject する)
 *
 * 呼び出し側は resolve したあとにリロードする (reject したときはリロードしない)。
 */
export async function clearCurrentModeData(): Promise<void> {
  getSessionStorageService().close();
  await deleteDatabaseAndWait(sessionDbName());
  removeKeys(localStorage, modeLocalStorageKeys());
  removeKeys(sessionStorage, modeSessionStorageKeys());
}
