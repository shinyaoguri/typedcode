/**
 * ThemeManager - ライト/ダークテーマの切り替え管理
 * Monaco Editor連携付きのテーママネージャー
 */

import { BaseThemeManager, type Theme, type ThemeManagerOptions } from '@typedcode/shared';
import type { MonacoEditor } from './types.js';

/** editor のテーマ設定。not-found (entry.ts) は Monaco を持たないので、これで `BaseThemeManager` を直に使う (#302)。 */
export const EDITOR_THEME_OPTIONS: ThemeManagerOptions = {
  storageKey: 'typedcode-theme',
  lightThemeColor: '#f5f5f5',
  darkThemeColor: '#1e1e1e',
};

export class ThemeManager extends BaseThemeManager {
  private editor: MonacoEditor;

  constructor(editor: MonacoEditor) {
    super(EDITOR_THEME_OPTIONS);
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
