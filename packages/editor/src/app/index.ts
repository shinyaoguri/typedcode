/**
 * App モジュール
 * アプリケーション初期化関連の機能を提供
 */

export { handleUrlParams } from './UrlParamHandler.js';
export { hasAcceptedTerms, showTermsModal, getTermsAcceptanceData, TERMS_CONSTANTS } from './TermsHandler.js';
export { clearAllAppData, clearStorageData } from './DataCleaner.js';
export { showNotification, initializeLogViewer, updateProofStatus, handleTemplateImport } from './AppHelpers.js';
export { isTemplateFile, importTemplateContent, handleTemplateDrop } from './TemplateHandler.js';
export { showLanguageDescriptionInTerminal } from './TerminalHandler.js';
export { handleTabChange } from './TabChangeHandler.js';
export { setupStaticEventListeners } from './StaticEventListeners.js';
export { showWelcomeScreen, hideWelcomeScreen } from './WelcomeScreenHandler.js';
