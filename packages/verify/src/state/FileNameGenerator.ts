/**
 * FileNameGenerator - ファイル名生成ユーティリティ
 *
 * 重複ファイル名のハンドリングと表示名生成を担当
 */

export class FileNameGenerator {
  private counter: Map<string, number> = new Map();

  /**
   * 次のファイル名番号を取得
   */
  getNextNumber(key: string): number {
    const count = this.counter.get(key) || 0;
    this.counter.set(key, count + 1);
    return count;
  }

  /**
   * 表示名を生成（重複ハンドリング付き）
   * @param filename 元のファイル名
   * @param folderId フォルダID（オプション）
   */
  generateDisplayName(filename: string, folderId?: string): string {
    const key = folderId ? `${folderId}:${filename}` : filename;
    const count = this.getNextNumber(key);

    if (count > 0) {
      const ext = filename.match(/\.[^.]+$/)?.[0] || '';
      const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
      return `${nameWithoutExt} (${count + 1})${ext}`;
    }

    return filename;
  }

  /**
   * フォルダ名を生成（重複ハンドリング付き）
   */
  generateFolderName(baseName: string): string {
    const key = `folder:${baseName}`;
    const count = this.getNextNumber(key);

    if (count > 0) {
      return `${baseName} (${count + 1})`;
    }
    return baseName;
  }

  /**
   * カウンターをリセット
   */
  reset(): void {
    this.counter.clear();
  }
}
