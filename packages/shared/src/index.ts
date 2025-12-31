/**
 * @typedcode/shared - 共有モジュール
 */

// 型定義
export * from './types.js';

// タイピング証明
export { TypingProof } from './typingProof.js';

// フィンガープリント
export { Fingerprint } from './fingerprint.js';

// 検証ユーティリティ
export {
  deterministicStringify,
  arrayBufferToHex,
  computeHash,
  verifyPoSW,
  verifyTypingProofHash,
  verifyChain,
  verifyProofFile,
} from './verification.js';

export type {
  ProofFile,
  FullVerificationResult,
  VerificationProgressCallback,
} from './verification.js';

// i18n (多言語対応)
export {
  I18nService,
  createI18nInstance,
  type I18nInstance,
  createDOMUpdater,
  type DOMUpdater,
} from './i18n/index.js';

export type { SupportedLocale, TranslationRecord } from './i18n/index.js';
