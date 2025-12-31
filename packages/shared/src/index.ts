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

// バージョン定数
export {
  PROOF_FORMAT_VERSION,
  STORAGE_FORMAT_VERSION,
  MIN_SUPPORTED_VERSION,
  parseVersion,
  compareVersions,
  isVersionSupported,
  getBuildInfo,
  GITHUB_REPO,
  GITHUB_URL,
  AUTHOR_GITHUB,
} from './version.js';
export type { BuildInfo } from './version.js';

// i18n (多言語対応)
export {
  I18nService,
  createI18nInstance,
  type I18nInstance,
  createDOMUpdater,
  type DOMUpdater,
} from './i18n/index.js';

export type { SupportedLocale, TranslationRecord } from './i18n/index.js';
