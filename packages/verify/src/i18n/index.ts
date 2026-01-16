/**
 * Verify-specific i18n module
 * Uses shared i18n infrastructure with verify-specific translations
 */
import { createI18nInstance, createDOMUpdater } from '@typedcode/shared';
import type { VerifyTranslationKeys } from './types.js';
import { ja } from './translations/ja.js';
import { en } from './translations/en.js';

// Create verify-specific i18n instance
const i18n = createI18nInstance<VerifyTranslationKeys>({ ja, en });

// Create DOM updater bound to this instance
const domUpdater = createDOMUpdater(() => i18n);

/**
 * Get I18nService instance
 */
export function getI18n() {
  return i18n;
}

/**
 * Convenience function for translation
 */
export function t(
  key: string,
  params?: Record<string, string | number>
): string {
  return i18n.t(key, params);
}

/**
 * Convenience function for message formatting
 */
export function formatMessage(
  template: string,
  params: Record<string, string | number>
): string {
  return i18n.formatMessage(template, params);
}

// Re-export DOM utilities
export const { updateDOMTranslations, initDOMi18n } = domUpdater;

// Re-export types
export type { SupportedLocale } from '@typedcode/shared';
export type { VerifyTranslationKeys } from './types.js';
