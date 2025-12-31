/**
 * i18n module - Internationalization utilities for TypedCode packages
 */

// Core service
export {
  I18nService,
  createI18nInstance,
  type I18nInstance,
} from './I18nService.js';

// DOM utilities
export { createDOMUpdater, type DOMUpdater } from './domUpdater.js';

// Types
export type { SupportedLocale, TranslationRecord } from './types.js';
