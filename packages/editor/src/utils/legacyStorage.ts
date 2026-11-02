/**
 * 廃止した localStorage キーの掃除 (#412)。
 *
 * 旧版は端末 ID を localStorage に永続化していたが、誰も読まないので
 * 収集をやめた (データ最小化、ADR-0024)。既存端末に残った値はここで 1 回消す。
 */

/** 廃止した端末 ID のキー。新しく書き込んではいけない。 */
export const LEGACY_DEVICE_ID_KEY = 'typedcode-device-id';

/**
 * 既存端末に残った端末 ID を消す。失敗 (ストレージ無効・例外) しても起動は止めない。
 * `storage` は注入できる (単体テスト用。既定は localStorage)。
 */
export function removeLegacyDeviceId(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(LEGACY_DEVICE_ID_KEY);
  } catch {
    // ストレージが使えなくても起動は続ける
  }
}
