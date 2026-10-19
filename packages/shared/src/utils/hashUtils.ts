/**
 * Hash Utilities - ハッシュ計算の共通ユーティリティ
 * SHA-256計算、決定的文字列化、バッファ変換を提供
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

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

/** 16 進 1 桁 → ASCII コード ('0'-'9', 'a'-'f')。computeHash の出力と同じ小文字 */
const HEX_ASCII = new Uint8Array([...'0123456789abcdef'].map((c) => c.charCodeAt(0)));

/**
 * PoSW の反復ハッシュを同期で計算する (#267)。
 *
 * `computeHash(seed)` を 1 回、以後その 16 進文字列に `computeHash` を `iterations - 1` 回
 * 掛けた結果と**ビット単位で同じ**値を返す (記録側 `PoswManager` / `poswWorker.ts` の手順)。
 * `await crypto.subtle.digest` を 1 反復ごとに挟むと Promise のオーバーヘッドが支配的になる
 * ため (Node で 10〜30 倍遅い)、検証側はこちらを使う。
 *
 * 実装は `@noble/hashes` の純 JS SHA-256 で、DOM / Node 固有 API に依存しない。
 * 16 進文字列は ASCII なので UTF-8 化 = 各桁の ASCII コード。64 バイトのバッファを
 * 使い回して反復ごとの文字列生成とエンコードを省く。
 */
export function iterateSha256HexSync(seedString: string, iterations: number): string {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  }

  let digest = sha256(utf8ToBytes(seedString));
  const hexAscii = new Uint8Array(64);
  for (let i = 1; i < iterations; i++) {
    for (let j = 0; j < 32; j++) {
      const byte = digest[j] as number;
      hexAscii[j * 2] = HEX_ASCII[byte >>> 4] as number;
      hexAscii[j * 2 + 1] = HEX_ASCII[byte & 0x0f] as number;
    }
    digest = sha256(hexAscii);
  }
  return bytesToHex(digest);
}
