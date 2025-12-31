import type { I18nService } from './I18nService';
import type { TranslationRecord } from './types';

/**
 * DOM updater functions interface
 */
export interface DOMUpdater {
  updateDOMTranslations: () => void;
  initDOMi18n: () => void;
  updateElementTranslation: (
    element: Element,
    key: string,
    params?: Record<string, string | number>
  ) => void;
  updateElementHtmlTranslation: (
    element: Element,
    key: string,
    params?: Record<string, string | number>
  ) => void;
}

/**
 * Create DOM updater functions bound to a specific I18nService instance
 */
export function createDOMUpdater<T extends TranslationRecord>(
  getI18n: () => I18nService<T>
): DOMUpdater {
  const t = (key: string, params?: Record<string, string | number>): string => {
    return getI18n().t(key, params);
  };

  /**
   * Update all DOM elements with data-i18n attributes
   * Call this after i18n initialization and on locale change
   */
  function updateDOMTranslations(): void {
    // Update text content
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = t(key);
      }
    });

    // Update HTML content (for elements with HTML tags in translation)
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (key) {
        el.innerHTML = t(key);
      }
    });

    // Update title attributes (tooltips)
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.setAttribute('title', t(key));
      }
    });

    // Update placeholder attributes
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.setAttribute('placeholder', t(key));
      }
    });

    // Update aria-label attributes
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) {
        el.setAttribute('aria-label', t(key));
      }
    });

    // Update HTML lang attribute
    document.documentElement.lang = getI18n().getLocale();
  }

  /**
   * Update a single element's translation
   */
  function updateElementTranslation(
    element: Element,
    key: string,
    params?: Record<string, string | number>
  ): void {
    element.textContent = t(key, params);
  }

  /**
   * Update a single element's HTML translation
   */
  function updateElementHtmlTranslation(
    element: Element,
    key: string,
    params?: Record<string, string | number>
  ): void {
    element.innerHTML = t(key, params);
  }

  /**
   * Initialize i18n for DOM
   * Sets up initial translations and locale change listener
   */
  function initDOMi18n(): void {
    // Apply initial translations
    updateDOMTranslations();

    // Listen for locale changes (for dynamic updates if needed)
    getI18n().onLocaleChange(() => {
      updateDOMTranslations();
    });
  }

  return {
    updateDOMTranslations,
    initDOMi18n,
    updateElementTranslation,
    updateElementHtmlTranslation,
  };
}
