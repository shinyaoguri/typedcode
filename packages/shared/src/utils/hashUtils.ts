/**
 * Hash Utilities - ハッシュ計算の共通ユーティリティ
 * SHA-256計算、決定的文字列化、バッファ変換を提供
 */

/**
 * オブジェクトをキーがソートされた決定的なJSON文字列に変換
 * ハッシュ計算時の一貫性を保証するため、キー順序を常にソート
 */
export function deterministicStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
          (sorted, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          },
          {} as Record<string, unknown>
        );
    }
    return value;
  });
}

/**
 * ArrayBufferを16進数文字列に変換
 */
export function arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(uint8Array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 文字列からSHA-256ハッシュを計算
 */
export async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return arrayBufferToHex(hashBuffer);
}
