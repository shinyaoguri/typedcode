/**
 * @typedcode/shared - 共有モジュール
 */

// 型定義
export * from './types.js';

// タイピング証明
export { TypingProof } from './typingProof.js';

// フィンガープリント
export { Fingerprint } from './fingerprint.js';

// デバッグログ制御 (デフォルト off。ホスト側が dev で有効化する)
export { setSharedDebug, isSharedDebugEnabled } from './utils/debug.js';

// 検証ユーティリティ
export {
  deterministicStringify,
  arrayBufferToHex,
  computeHash,
  verifyPoSW,
  verifyInitialHashRoot,
  verifyFinalChainHash,
  verifyContentReplay,
  verifyCheckpoints,
  verifyProofMetadata,
  verifyTypingProofHash,
  verifyChain,
  verifyProofFile,
  calculatePoswStats,
} from './verification.js';

export type {
  ProofFile,
  FullVerificationResult,
  VerificationProgressCallback,
  PoswStats,
  VerificationMode,
  VerifyProofFileOptions,
} from './verification.js';

// Signed checkpoints (long-term verifiability)
export {
  hashSignedCheckpointPayload,
  resolveCheckpointPublicKey,
  verifyCheckpointSignature,
  verifySignedCheckpoints,
  verifyProofSignedCheckpoints,
  createSignedCheckpointEnvelope,
  validateSignedCheckpointInput,
  isIdempotentSigningRetry,
} from './signedCheckpoints.js';

export type {
  SignedCheckpointInput,
  SignedCheckpointServerContext,
  SignedCheckpointSigner,
} from './signedCheckpoints.js';

export {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
} from './checkpointKeys/index.js';

export type {
  CheckpointPublicKey,
  CheckpointPublicKeyStatus,
} from './checkpointKeys/index.js';

// バージョン定数
export {
  PROOF_FORMAT_VERSION,
  STORAGE_FORMAT_VERSION,
  POSW_ITERATIONS,
  SIGNED_CHECKPOINT_FORMAT_VERSION,
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

// 計算ユーティリティ
export {
  formatTypingTime,
  calculateTypingSpeed,
  countPasteEvents,
  countDropEvents,
  calculateChartStats,
  type ChartStats,
} from './calculations.js';

// 人間認証サービス
export {
  AttestationService,
  type HumanAttestation,
  type AttestationVerificationResult,
  type AttestationVerificationDetails,
} from './attestation.js';

// ファイル処理
export {
  // Types
  type FileType,
  type ParsedFileData,
  type ProofFileCore,
  type ZipParseResult,
  type FileParseCallbacks,
  type ScreenshotManifest,
  type ScreenshotManifestEntry,
  // Language detection
  getLanguageFromExtension,
  isBinaryFile,
  getFileType,
  isProofFilename,
  // Parser
  isProofFile,
  parseJsonString,
  parseZipBuffer,
  extractFirstProofFromZip,
} from './fileProcessing/index.js';

// UI共通コンポーネント
export {
  BaseThemeManager,
  type Theme,
  type ThemeManagerOptions,
} from './ui/index.js';

// タイピングパターン分析
export { TypingPatternAnalyzer } from './typingPattern/index.js';

// ユーティリティ関数
export { escapeHtml } from './utils/index.js';

// カスタムエラークラス
export {
  TypingProofError,
  ChainVerificationError,
  PoswError,
  WorkerError,
  isTypingProofError,
  hasErrorCode,
} from './errors.js';
export type { TypingProofErrorCode } from './errors.js';
