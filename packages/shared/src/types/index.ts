/**
 * TypedCode - 型定義ファイル
 * プロジェクト全体で使用する共通の型定義
 *
 * すべての型をドメイン別ファイルから再エクスポート
 */

// イベント関連
export type {
  EventType,
  InputType,
  DeleteDirection,
  TextRange,
  CursorPosition,
  SelectionData,
  CursorPositionData,
  MousePositionData,
  VisibilityChangeData,
  FocusChangeData,
  WindowSizeData,
  NetworkStatusData,
  SessionResumedData,
  KeystrokeDynamicsData,
  DetectedEventType,
  DetectedEventData,
  DetectedEvent,
  OnDetectedCallback,
  OperationResult,
} from './events.js';

// スクリーンショット関連
export type {
  ScreenshotCaptureType,
  DisplayInfo,
  ScreenshotCaptureData,
  StoredScreenshot,
  StoredScreenshotData,
  ScreenCapturePermissionState,
  ScreenShareStartData,
  ScreenShareStopData,
  ScreenShareOptOutData,
} from './screenshot.js';

// 認証関連
export type {
  VerificationFailureReason,
  HumanAttestationEventData,
  TermsAcceptedData,
} from './attestation.js';

// フィンガープリント関連
export type {
  ScreenInfo,
  WebGLInfo,
  FingerprintComponents,
  StableInfo,
  DetailedFingerprint,
} from './fingerprint.js';

// 証明データ関連
export type {
  PoSWData,
  RecordEventInput,
  EventHashData,
  StoredEvent,
  RecordEventResult,
  ProofMetadata,
  ProofData,
  SignatureData,
  TypingProofHashResult,
  CheckpointData,
  ExportedProof,
} from './proof.js';

// テンプレート関連
export type {
  TemplateFileDefinition,
  TemplateMetadata,
  ParsedTemplate,
  TemplateInjectionEventData,
} from './template.js';

// 検証関連
export type {
  SampledSegmentInfo,
  SampledVerificationResult,
  VerificationResult,
  TypingProofVerificationResult,
} from './verification.js';

// 統計関連
export type {
  EventTypeCounts,
  InputTypeCounts,
  TypingStats,
  TypingStatistics,
  LogStats,
} from './statistics.js';

// タイピングパターン分析関連
export type {
  PatternJudgment,
  IssueSeverity,
  MetricKey,
  MetricScore,
  MetricAnalysis,
  TypingPatternIssue,
  TypingPatternRawStats,
  TypingPatternAnalysis,
  TypingPatternAnalyzerConfig,
} from './typingPattern.js';
export { DEFAULT_TYPING_PATTERN_ANALYZER_CONFIG } from './typingPattern.js';

// ストレージ・マルチタブ関連
export type {
  TabSwitchEvent,
  SerializedProofState,
  VerificationState,
  VerificationDetails,
  SerializedTabState,
  MultiTabStorage,
  MultiFileExportEntry,
  MultiFileExportedProof,
  SeekbarEventInfo,
  ContentCache,
  // IndexedDB セッション永続化関連
  SessionMetadata,
  StoredTabData,
  StoredEventData,
  StoredTabSwitchData,
  SessionSummary,
  TabSummary,
  // Pending Event（PoSW未完了イベント）
  PendingEventData,
  PendingEventDataType,
} from './storage.js';
export { INDEXEDDB_SESSION_VERSION } from './storage.js';

// 共通
export type { Theme } from './common.js';

// ============================================================================
// 統合型・ユーティリティ
// ============================================================================

import type { ExportedProof } from './proof.js';
import type { MultiFileExportedProof } from './storage.js';

/** エクスポートプルーフの統合型 */
export type AnyExportedProof = ExportedProof | MultiFileExportedProof;

/** マルチファイルプルーフかどうかを判定する型ガード */
export function isMultiFileProof(data: AnyExportedProof): data is MultiFileExportedProof {
  return 'type' in data && data.type === 'multi-file';
}

// ============================================================================
// グローバル拡張
// ============================================================================

/** Window拡張（clipboardData for IE） */
declare global {
  interface Window {
    clipboardData?: DataTransfer;
  }

  interface Navigator {
    deviceMemory?: number;
  }
}
