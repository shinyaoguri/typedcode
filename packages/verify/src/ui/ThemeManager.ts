/**
 * ThemeManager - Handles dark/light theme switching
 * verify アプリケーション用のテーママネージャー
 */

import { BaseThemeManager } from '@typedcode/shared';

export class ThemeManager extends BaseThemeManager {
  constructor() {
    super({
      storageKey: 'typedcode-verify-theme',
      lightThemeColor: '#E64A19',
      darkThemeColor: '#FF5722',
    });
  }
}
