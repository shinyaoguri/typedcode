/**
 * Theme Manager - Handles dark/light theme switching
 */
export class ThemeManager {
  private static STORAGE_KEY = 'typedcode-verify-theme';
  private currentTheme: 'dark' | 'light' = 'dark';

  constructor() {
    this.loadTheme();
  }

  private loadTheme(): void {
    const savedTheme = localStorage.getItem(ThemeManager.STORAGE_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') {
      this.currentTheme = savedTheme;
    } else {
      // Check system preference
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        this.currentTheme = 'light';
      }
    }
    this.applyTheme();
  }

  private applyTheme(): void {
    document.documentElement.setAttribute('data-theme', this.currentTheme);

    // Update meta theme-color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', this.currentTheme === 'dark' ? '#FF5722' : '#E64A19');
    }
  }

  toggle(): void {
    this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(ThemeManager.STORAGE_KEY, this.currentTheme);
    this.applyTheme();
  }

  getTheme(): 'dark' | 'light' {
    return this.currentTheme;
  }

  isDark(): boolean {
    return this.currentTheme === 'dark';
  }
}
