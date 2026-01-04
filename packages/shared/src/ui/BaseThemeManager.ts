/**
 * BaseThemeManager - 共通テーマ管理ベースクラス
 * editor/verifyパッケージで共有される基本的なテーマ管理機能を提供
 */

export type Theme = 'light' | 'dark';

export interface ThemeManagerOptions {
  /** localStorage のキー */
  storageKey?: string;
  /** ライトテーマ時の theme-color */
  lightThemeColor?: string;
  /** ダークテーマ時の theme-color */
  darkThemeColor?: string;
}

const DEFAULT_OPTIONS: Required<ThemeManagerOptions> = {
  storageKey: 'typedcode-theme',
  lightThemeColor: '#f5f5f5',
  darkThemeColor: '#1e1e1e',
};

export class BaseThemeManager {
  protected currentTheme: Theme;
  protected options: Required<ThemeManagerOptions>;

  constructor(options: ThemeManagerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.currentTheme = this.loadTheme();
    this.applyTheme(this.currentTheme);
  }

  /**
   * 保存されたテーマを読み込む
   */
  protected loadTheme(): Theme {
    const savedTheme = localStorage.getItem(this.options.storageKey);
    if (savedTheme === 'light' || savedTheme === 'dark') {
      return savedTheme;
    }
    // システム設定をチェック
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  /**
   * テーマを保存
   */
  protected saveTheme(theme: Theme): void {
    localStorage.setItem(this.options.storageKey, theme);
  }

  /**
   * テーマを適用
   * サブクラスでオーバーライド可能
   */
  applyTheme(theme: Theme): void {
    this.currentTheme = theme;

    // HTMLのdata-theme属性を設定
    document.documentElement.setAttribute('data-theme', theme);

    // theme-color metaタグを更新
    this.updateThemeColorMeta(theme);

    this.saveTheme(theme);
  }

  /**
   * theme-color metaタグを更新
   */
  protected updateThemeColorMeta(theme: Theme): void {
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      const color = theme === 'light' ? this.options.lightThemeColor : this.options.darkThemeColor;
      themeColorMeta.setAttribute('content', color);
    }
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
