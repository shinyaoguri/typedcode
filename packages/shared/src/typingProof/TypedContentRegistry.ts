/**
 * TypedContentRegistry - 入力済みコンテンツの追跡
 * アプリ内で入力されたコンテンツのハッシュを追跡し、
 * 内部ペーストと外部ペーストを区別するために使用
 */

/**
 * 高速なハッシュ関数（セキュリティ用ではなく、ルックアップ用）
 */
function fastHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

export class TypedContentRegistry {
  private contentHashes: Set<string> = new Set();
  private contentStore: string[] = [];
  private readonly MAX_ENTRIES = 10000;
  private readonly SEGMENT_SIZE = 50;
  private readonly SEGMENT_STEP = 25;

  /**
   * 入力されたコンテンツを登録
   */
  registerContent(content: string): void {
    if (!content) return;

    // 完全なコンテンツのハッシュを登録
    const hash = fastHash(content);
    this.contentHashes.add(hash);

    // 部分文字列マッチング用にコンテンツを保存
    this.contentStore.push(content);

    // 大きなコンテンツの場合、セグメントも登録
    if (content.length > this.SEGMENT_SIZE) {
      for (let i = 0; i < content.length - this.SEGMENT_SIZE; i += this.SEGMENT_STEP) {
        const segment = content.substring(i, i + this.SEGMENT_SIZE);
        this.contentHashes.add(fastHash(segment));
      }
    }

    // エントリ数制限（LRU的に古いものを削除）
    if (this.contentStore.length > this.MAX_ENTRIES) {
      const removed = this.contentStore.shift();
      if (removed) {
        // 注意: ハッシュは他のコンテンツでも使われている可能性があるため削除しない
        // メモリ効率より正確性を優先
      }
    }
  }

  /**
   * コンテンツが内部で入力されたものかチェック
   */
  isInternalContent(content: string): boolean {
    if (!content) return false;

    // 完全一致チェック
    const hash = fastHash(content);
    if (this.contentHashes.has(hash)) {
      return true;
    }

    // 部分文字列チェック（ペーストされたコンテンツが入力済みコンテンツの一部か）
    for (const stored of this.contentStore) {
      if (stored.includes(content)) {
        return true;
      }
    }

    // 入力済みコンテンツがペーストされたコンテンツの一部か
    // （複数の入力済みコンテンツを組み合わせた可能性）
    // この場合は厳密には外部コンテンツの可能性があるため、falseを返す

    return false;
  }

  /**
   * レジストリをクリア
   */
  clear(): void {
    this.contentHashes.clear();
    this.contentStore = [];
  }

  /**
   * 登録されているコンテンツ数を取得
   */
  get size(): number {
    return this.contentStore.length;
  }
}
