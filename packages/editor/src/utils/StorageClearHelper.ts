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
 * 削除が `blocked` になってから、失敗とみなすまで待つ時間 (#524)。自分の接続の close が終わるのを待つための
 * 猶予で、トランザクション 1 本が終わるには十分な長さにしてある。
 */
export const DELETE_BLOCKED_GRACE_MS = 5_000;

export interface DeleteDatabaseOptions {
  /** `blocked` から失敗とみなすまでの猶予 (ms)。既定は `DELETE_BLOCKED_GRACE_MS` (テストで短くする用)。 */
  readonly blockedGraceMs?: number;
}

/**
 * IndexedDB を削除し、完了 (`success`) を待つ。
 *
 * `blocked` はすぐには失敗にしない (#524)。`IDBDatabase.close()` は接続を close pending にするだけで、
 * その接続で走っているトランザクションが終わるまで接続は閉じない。その間に削除を出すと Chromium は先に
 * `blocked` を出し、トランザクションの完了後に `success` を出す (保存の書き込みが続いている最中のリセットで
 * 起きる)。なので `blocked` を受けたら猶予 (`blockedGraceMs`) だけ `success` を待ち、過ぎたら別タブなど閉じない
 * 接続が握っているとみなして reject する。`error` はその場で reject する。reject したときは呼び出し側が
 * キーを残し、リロードしない (消えていないまま先へ進まない)。
 */
export function deleteDatabaseAndWait(name: string, options: DeleteDatabaseOptions = {}): Promise<void> {
  const graceMs = options.blockedGraceMs ?? DELETE_BLOCKED_GRACE_MS;
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(`deleteDatabase(${name}) threw`));
      return;
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      finish();
    };
    request.onsuccess = () => settle(resolve);
    request.onerror = () => settle(() => reject(request.error ?? new Error(`deleteDatabase(${name}) failed`)));
    request.onblocked = () => {
      if (settled || graceTimer !== undefined) return;
      graceTimer = setTimeout(
        () =>
          settle(() =>
            reject(new Error(`deleteDatabase(${name}) is still blocked by another open connection after ${graceMs}ms`))
          ),
        graceMs
      );
    };
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
 * 2. session DB の削除の完了を待つ。自分の接続で走っていたトランザクションが終わるまでの一時的な blocked は
 *    猶予 (`DELETE_BLOCKED_GRACE_MS`) まで待つ。猶予を過ぎても blocked のままなら失敗にする (#524)
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
