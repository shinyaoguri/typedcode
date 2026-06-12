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

// プロセス要約 (Phase 8 W3) — 制作過程の見どころを決定的に抽出 (中立な記述、疑い指標ではない)
export {
  summarizeProcess,
  PROCESS_PAUSE_THRESHOLD_MS,
  PROCESS_FOCUS_BURST_WINDOW_MS,
  PROCESS_FOCUS_BURST_MIN_CHARS,
  PROCESS_MAX_EXTERNAL_INPUT_MOMENTS,
} from './processSummary.js';
export type { ProcessSummary, ProcessKeyMoment, ProcessMomentKind } from './processSummary.js';

// 三層保証語彙 (ADR-0020) — 実証拠から integrity / temporal / provenance を機械導出
export { deriveAssurance, summarizeAnalysisForAssurance } from './assurance.js';
export type {
  AssuranceInput,
  AssuranceResult,
  IntegrityLevel,
  TemporalLevel,
  ProvenanceAdvisory,
} from './assurance.js';

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
  createSessionStartToken,
  validateSessionStartInput,
  verifySessionStartToken,
  computeAnchoredChainRoot,
} from './sessionStartToken.js';

export type {
  SessionStartInput,
  SessionStartServerContext,
  SessionStartSigner,
} from './sessionStartToken.js';

export {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
} from './checkpointKeys/index.js';

export type {
  CheckpointPublicKey,
  CheckpointPublicKeyStatus,
} from './checkpointKeys/index.js';

// 試験モード (ADR-0006): 封印問題パッケージ + 監督コード束縛
export {
  EXAM_AUTHORITY_KEYS,
  findExamAuthorityKey,
} from './examAuthorityKeys/index.js';

export type {
  ExamAuthorityKey,
  ExamAuthorityKeyStatus,
} from './examAuthorityKeys/index.js';

export {
  canonicalizeStartToken,
  parseExamPackageManifest,
  examPackageSigningCore,
  computeExamPackageHash,
  computeProblemContentHash,
  computeExamChainRoot,
  deriveExamKey,
  decryptExamPackage,
  buildExamPackage,
  verifyExamPackageSignature,
  verifyExamBinding,
  buildExamProofBlock,
  DEFAULT_EXAM_KDF_PARAMS,
  EXAM_BUNDLE_SCHEMA,
  parseExamBundle,
  decodeExamPlaintext,
  encodeExamBundle,
  computeBundleProblemHash,
  CLASS_PACKAGE_SCHEMA,
  parseClassPackage,
  encodeClassPackage,
} from './exam/index.js';

export type {
  ExamDecryptResult,
  ExamPackageSigner,
  ExamPackageBuildInput,
  ExamPackageSignatureResult,
  ExamTimeBox,
  ExamBindingVerificationResult,
  VerifyExamBindingOptions,
  BuildExamProofBlockInput,
} from './exam/index.js';

// バージョン定数
export {
  PROOF_FORMAT_VERSION,
  STORAGE_FORMAT_VERSION,
  POSW_ITERATIONS,
  SIGNED_CHECKPOINT_FORMAT_VERSION,
  SESSION_TOKEN_FORMAT_VERSION,
  EXAM_PACKAGE_FORMAT_VERSION,
  EXAM_PROOF_VERSION,
  EXAM_ROOT_BINDING,
  EXAM_ROOT_BINDING_V2,
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
  extractAllProofsFromZip,
} from './fileProcessing/index.js';

// UI共通コンポーネント
export {
  BaseThemeManager,
  type Theme,
  type ThemeManagerOptions,
} from './ui/index.js';

// タイピングパターン分析
export { TypingPatternAnalyzer } from './typingPattern/index.js';

// 分析層 (ADR-0009): 検証と直交する pluggable な分析フレームワーク (器のみ)
export { runAnalysis, defaultAnalyzers } from './analysis/index.js';
export type {
  AnalysisDimension,
  AnalysisSeverity,
  EvidenceRef,
  AnalysisSignal,
  AnalysisInput,
  Analyzer,
  AnalysisReport,
} from './analysis/index.js';

// 分析器の実証評価 (W5): ラベル付きコーパス → 混同行列/閾値スイープ (純粋関数)
export { evaluateAnalysis, formatEvalReportMarkdown } from './analysis/index.js';
export type {
  EvalLabel,
  LabeledAnalysis,
  ConfusionPoint,
  DimensionEval,
  GenuineSignalRate,
  EvalReport,
  EvaluateOptions,
} from './analysis/index.js';

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
