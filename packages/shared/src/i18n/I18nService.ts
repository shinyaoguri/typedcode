import type { SupportedLocale, TranslationRecord } from './types';

const LOCALE_STORAGE_KEY = 'typedcode-locale';
const DEFAULT_LOCALE: SupportedLocale = 'ja';

/**
 * Generic i18n service for TypedCode packages
 * Singleton pattern with language detection and persistence
 */
export class I18nService<T extends TranslationRecord = TranslationRecord> {
  private translations: Record<SupportedLocale, T>;
  private currentLocale: SupportedLocale;
  private listeners: Set<(locale: SupportedLocale) => void> = new Set();

  constructor(translations: Record<SupportedLocale, T>) {
    this.translations = translations;
    this.currentLocale = this.detectLocale();
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
    let value: unknown = this.translations[this.currentLocale];

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

/**
 * I18n instance interface for type safety
 */
export type I18nInstance<T extends TranslationRecord = TranslationRecord> =
  I18nService<T>;

/**
 * Create a new I18nService instance with the provided translations
 */
export function createI18nInstance<T extends TranslationRecord>(
  translations: Record<SupportedLocale, T>
): I18nService<T> {
  return new I18nService<T>(translations);
}
