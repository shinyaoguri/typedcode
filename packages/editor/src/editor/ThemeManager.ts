/**
 * ThemeManager - ライト/ダークテーマの切り替え管理
 */

import type { Theme } from '@typedcode/shared';
import type { MonacoEditor } from './types.js';

export class ThemeManager {
  private editor: MonacoEditor;
  private currentTheme: Theme;

  constructor(editor: MonacoEditor) {
    this.editor = editor;
    this.currentTheme = this.loadTheme();
    this.applyTheme(this.currentTheme);
  }

  /**
   * 保存されたテーマを読み込む
   */
  private loadTheme(): Theme {
    const savedTheme = localStorage.getItem('typedcode-theme');
    return (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
  }

  /**
   * テーマを保存
   */
  private saveTheme(theme: Theme): void {
    localStorage.setItem('typedcode-theme', theme);
  }

  /**
   * テーマを適用
   */
  applyTheme(theme: Theme): void {
    this.currentTheme = theme;

    // HTMLのdata-theme属性を設定
    document.documentElement.setAttribute('data-theme', theme);

    // Monaco Editorのテーマを変更
    if (this.editor) {
      const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';
      this.editor.updateOptions({ theme: monacoTheme });
    }

    // theme-color metaタグを更新
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', theme === 'light' ? '#f5f5f5' : '#1e1e1e');
    }

    this.saveTheme(theme);
  }

  /**
   * テーマを切り替え
   */
  toggle(): Theme {
    const newTheme: Theme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.applyTheme(newTheme);
    return newTheme;
  }

  /**
   * 現在のテーマを取得
   */
  getTheme(): Theme {
    return this.currentTheme;
  }

  /**
   * ライトテーマかどうか
   */
  isLight(): boolean {
    return this.currentTheme === 'light';
  }

  /**
   * ダークテーマかどうか
   */
  isDark(): boolean {
    return this.currentTheme === 'dark';
  }
}
