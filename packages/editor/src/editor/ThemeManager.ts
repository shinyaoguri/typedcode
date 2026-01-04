/**
 * ThemeManager - ライト/ダークテーマの切り替え管理
 * Monaco Editor連携付きのテーママネージャー
 */

import { BaseThemeManager, type Theme } from '@typedcode/shared';
import type { MonacoEditor } from './types.js';

export class ThemeManager extends BaseThemeManager {
  private editor: MonacoEditor;

  constructor(editor: MonacoEditor) {
    super({
      storageKey: 'typedcode-theme',
      lightThemeColor: '#f5f5f5',
      darkThemeColor: '#1e1e1e',
    });
    this.editor = editor;
    // コンストラクタで初期テーマが適用済みなので、エディタテーマも適用
    this.updateEditorTheme(this.currentTheme);
  }

  /**
   * テーマを適用（オーバーライド）
   */
  override applyTheme(theme: Theme): void {
    super.applyTheme(theme);
    this.updateEditorTheme(theme);
  }

  /**
   * Monaco Editorのテーマを更新
   */
  private updateEditorTheme(theme: Theme): void {
    if (this.editor) {
      const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';
      this.editor.updateOptions({ theme: monacoTheme });
    }
  }
}
