/**
 * App モジュール
 * アプリケーション初期化関連の機能を提供
 */

export { handleUrlParams } from './UrlParamHandler.js';
export { hasAcceptedTerms, showTermsModal, getTermsAcceptanceData, TERMS_CONSTANTS } from './TermsHandler.js';
export { clearAllAppData, clearStorageData } from './DataCleaner.js';
