/**
 * Supported locales
 */
export type SupportedLocale = 'ja' | 'en';

/**
 * Generic translation record type
 * Each package defines its own specific TranslationKeys interface
 */
export type TranslationRecord = Record<string, unknown>;
