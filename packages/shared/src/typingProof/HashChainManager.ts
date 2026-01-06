/**
 * HashChainManager - ハッシュチェーン管理
 * SHA-256計算、決定的文字列化、チェーン状態管理を担当
 */

import {
  deterministicStringify as deterministicStringifyUtil,
  arrayBufferToHex as arrayBufferToHexUtil,
  computeHash as computeHashUtil,
} from '../utils/hashUtils.js';

export class HashChainManager {
  private currentHash: string | null = null;

  /**
   * 現在のハッシュを取得
   */
  getCurrentHash(): string | null {
    return this.currentHash;
  }

  /**
   * 現在のハッシュを設定
   */
  setCurrentHash(hash: string | null): void {
    this.currentHash = hash;
  }

  /**
   * 初期ハッシュを生成（フィンガープリント + ランダム値）
   */
  async initialHash(fingerprintHash: string): Promise<string> {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const randomHex = this.arrayBufferToHex(randomData);

    const combined = fingerprintHash + randomHex;
    return await this.computeHash(combined);
  }

  /**
   * オブジェクトをキーがソートされた決定的なJSON文字列に変換
   * ハッシュ計算時の一貫性を保証するため、キー順序を常にソート
   */
  deterministicStringify(obj: unknown): string {
    return deterministicStringifyUtil(obj);
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
    return arrayBufferToHexUtil(buffer);
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data: string): Promise<string> {
    return computeHashUtil(data);
  }
}
