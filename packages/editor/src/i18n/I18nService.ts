import type { SupportedLocale, TranslationKeys } from './types';
import { ja } from './translations/ja';
import { en } from './translations/en';

const LOCALE_STORAGE_KEY = 'typedcode-locale';
const DEFAULT_LOCALE: SupportedLocale = 'ja';

const translations: Record<SupportedLocale, TranslationKeys> = { ja, en };

/**
 * Lightweight i18n service for TypedCode editor
 * Singleton pattern with language detection and persistence
 */
export class I18nService {
  private static instance: I18nService | null = null;
  private currentLocale: SupportedLocale;
  private listeners: Set<(locale: SupportedLocale) => void> = new Set();

  private constructor() {
    this.currentLocale = this.detectLocale();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): I18nService {
    if (!I18nService.instance) {
      I18nService.instance = new I18nService();
    }
    return I18nService.instance;
  }

  /**
   * Detect locale from LocalStorage or browser settings
   * Priority: LocalStorage > Browser language > Default (ja)
   */
  private detectLocale(): SupportedLocale {
    // 1. Check LocalStorage
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored === 'ja' || stored === 'en') {
        return stored;
      }
    } catch {
      // LocalStorage not available
    }

    // 2. Check browser language
    const browserLang = navigator.language.split('-')[0];
    if (browserLang === 'en') {
      return 'en';
    }

    // 3. Fallback to Japanese
    return DEFAULT_LOCALE;
  }

  /**
   * Get current locale
   */
  getLocale(): SupportedLocale {
    return this.currentLocale;
  }

  /**
   * Set locale and persist to LocalStorage
   */
  setLocale(locale: SupportedLocale): void {
    if (this.currentLocale === locale) return;

    this.currentLocale = locale;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // LocalStorage not available
    }

    // Notify listeners
    this.listeners.forEach((listener) => listener(locale));
  }

  /**
   * Subscribe to locale change events
   * @returns Unsubscribe function
   */
  onLocaleChange(callback: (locale: SupportedLocale) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Get translation by dot-notation key
   * @param key - Dot-notation key (e.g., "common.cancel")
   * @param params - Optional interpolation parameters
   * @returns Translated string or key as fallback
   */
  t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: unknown = translations[this.currentLocale];

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = (value as Record<string, unknown>)[k];
      } else {
        console.warn(`[i18n] Missing translation: ${key}`);
        return key;
      }
    }

    if (typeof value !== 'string') {
      console.warn(`[i18n] Translation is not a string: ${key}`);
      return key;
    }

    // Handle interpolation
    if (params) {
      return this.formatMessage(value, params);
    }

    return value;
  }

  /**
   * Format message with interpolation
   * Replaces ${key} with corresponding value from params
   */
  formatMessage(
    template: string,
    params: Record<string, string | number>
  ): string {
    return template.replace(/\$\{(\w+)\}/g, (_, key) => {
      return String(params[key] ?? `\${${key}}`);
    });
  }

  /**
   * Get translation that may contain HTML
   * Same as t() but explicitly for HTML content
   */
  tHtml(key: string, params?: Record<string, string | number>): string {
    return this.t(key, params);
  }

  /**
   * Get all supported locales
   */
  getSupportedLocales(): SupportedLocale[] {
    return ['ja', 'en'];
  }

  /**
   * Get display name for a locale
   */
  getLocaleDisplayName(locale: SupportedLocale): string {
    const names: Record<SupportedLocale, string> = {
      ja: '日本語',
      en: 'English',
    };
    return names[locale];
  }
}

// Singleton instance cache
let i18nInstance: I18nService | null = null;

/**
 * Get I18nService instance
 */
export function getI18n(): I18nService {
  if (!i18nInstance) {
    i18nInstance = I18nService.getInstance();
  }
  return i18nInstance;
}

/**
 * Convenience function for translation
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return getI18n().t(key, params);
}

/**
 * Convenience function for message formatting
 */
export function formatMessage(
  template: string,
  params: Record<string, string | number>
): string {
  return getI18n().formatMessage(template, params);
}
