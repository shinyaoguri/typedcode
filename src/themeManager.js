/**
 * ThemeManager - ライト/ダークテーマの切り替え管理
 */

export class ThemeManager {
  constructor(editor) {
    this.editor = editor;
    this.currentTheme = this.loadTheme();
    this.applyTheme(this.currentTheme);
  }

  /**
   * 保存されたテーマを読み込む
   */
  loadTheme() {
    const savedTheme = localStorage.getItem('typedcode-theme');
    return savedTheme || 'dark'; // デフォルトはダーク
  }

  /**
   * テーマを保存
   */
  saveTheme(theme) {
    localStorage.setItem('typedcode-theme', theme);
  }

  /**
   * テーマを適用
   */
  applyTheme(theme) {
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
      themeColorMeta.content = theme === 'light' ? '#f5f5f5' : '#1e1e1e';
    }

    this.saveTheme(theme);
  }

  /**
   * テーマを切り替え
   */
  toggle() {
    const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.applyTheme(newTheme);
    return newTheme;
  }

  /**
   * 現在のテーマを取得
   */
  getTheme() {
    return this.currentTheme;
  }

  /**
   * ライトテーマかどうか
   */
  isLight() {
    return this.currentTheme === 'light';
  }

  /**
   * ダークテーマかどうか
   */
  isDark() {
    return this.currentTheme === 'dark';
  }
}
