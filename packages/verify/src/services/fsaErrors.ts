/**
 * File System Access API の失敗の見分け (#703)。
 *
 * 「無い」(`NotFoundError`。`screenshots` がファイルだったときの `TypeMismatchError` も無いと見る) は確定した状態で、
 * 0 枚・欠損として扱ってよい。それ以外 (`NotReadableError` など) は一時的な読み取りの失敗で、「無い」と見て判定を
 * 確定させてはいけない (#699 のフォルダ監視と同じ考え方)。
 */
export function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}
