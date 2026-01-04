/**
 * HashChainManager - ハッシュチェーン管理
 * SHA-256計算、決定的文字列化、チェーン状態管理を担当
 */

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
    return JSON.stringify(obj, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, unknown>).sort().reduce((sorted, k) => {
          sorted[k] = (value as Record<string, unknown>)[k];
          return sorted;
        }, {} as Record<string, unknown>);
      }
      return value;
    });
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
    const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return Array.from(uint8Array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return this.arrayBufferToHex(hashBuffer);
  }
}
