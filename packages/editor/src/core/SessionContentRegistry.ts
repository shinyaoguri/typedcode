/**
 * SessionContentRegistry - セッションレベルのコンテンツレジストリ
 *
 * アプリ内で入力されたすべてのコンテンツを追跡し、
 * ペースト時に内部コンテンツか外部コンテンツかを判定する。
 * 複数タブ間での内部ペーストをサポートする。
 */

/**
 * 全タブのコンテンツを取得するコールバック型
 */
export type GetAllContentsCallback = () => string[];

export class SessionContentRegistry {
  private copiedContent: Set<string> = new Set();
  private getAllContents: GetAllContentsCallback | null = null;
  private readonly MAX_COPIED_ENTRIES = 1000;

  /**
   * 全タブのコンテンツを取得するコールバックを設定
   * @param callback - コールバック関数
   */
  setGetAllContentsCallback(callback: GetAllContentsCallback): void {
    this.getAllContents = callback;
  }

  /**
   * コピーされたコンテンツを登録
   * コピー操作時に呼び出され、ペースト判定の補助に使用
   * @param content - コピーされたテキスト
   */
  registerCopiedContent(content: string): void {
    if (!content) return;
    this.copiedContent.add(content);

    // エントリ数制限
    if (this.copiedContent.size > this.MAX_COPIED_ENTRIES) {
      const firstKey = this.copiedContent.values().next().value;
      if (firstKey !== undefined) {
        this.copiedContent.delete(firstKey);
      }
    }
  }

  /**
   * コンテンツが内部で入力されたものかチェック
   * @param content - チェックするコンテンツ
   * @returns 内部コンテンツならtrue
   */
  isInternalContent(content: string): boolean {
    if (!content) return false;

    // コピーされたコンテンツと完全一致するかチェック（高速パス）
    if (this.copiedContent.has(content)) {
      return true;
    }

    // 全タブの現在のコンテンツに対して部分文字列マッチング
    if (this.getAllContents) {
      const allContents = this.getAllContents();
      for (const tabContent of allContents) {
        if (tabContent && tabContent.includes(content)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * レジストリをクリア
   */
  clear(): void {
    this.copiedContent.clear();
  }
}
