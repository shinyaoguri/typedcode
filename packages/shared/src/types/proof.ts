/**
 * 証明データ関連の型定義
 */

import type {
  EventType,
  InputType,
  DeleteDirection,
  TextRange,
  CursorPositionData,
  SelectionData,
  MousePositionData,
  VisibilityChangeData,
  FocusChangeData,
  KeystrokeDynamicsData,
  WindowSizeData,
  NetworkStatusData,
  SessionResumedData,
  EnvironmentProbeData,
  FullscreenChangeData,
  ExamOpenedEventData,
} from './events.js';
import type { ExamProofBlock } from './exam.js';
import type {
  ScreenshotCaptureData,
  ScreenShareStartData,
  ScreenShareStopData,
  ScreenShareOptOutData,
} from './screenshot.js';
import type { HumanAttestationEventData, TermsAcceptedData } from './attestation.js';
import type { FingerprintComponents } from './fingerprint.js';
import type { TemplateInjectionEventData } from './template.js';

// ============================================================================
// PoSW関連
// ============================================================================

/** Proof of Sequential Work データ */
export interface PoSWData {
  iterations: number;       // 反復回数
  nonce: string;            // 計算で使用したnonce
  intermediateHash: string; // 中間ハッシュ（検証用）
  computeTimeMs: number;    // 計算時間（参考値、ミリ秒）
}

// ============================================================================
// イベントデータ
// ============================================================================

/** イベント記録時の入力データ */
export interface RecordEventInput {
  type: EventType;
  inputType?: InputType | null;
  data?: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | WindowSizeData | NetworkStatusData | SessionResumedData | HumanAttestationEventData | TermsAcceptedData | ScreenshotCaptureData | ScreenShareStartData | ScreenShareStopData | ScreenShareOptOutData | TemplateInjectionEventData | EnvironmentProbeData | FullscreenChangeData | ExamOpenedEventData | null;
  rangeOffset?: number | null;
  rangeLength?: number | null;
  range?: TextRange | null;
  description?: string | null;
  isMultiLine?: boolean | null;
  deletedLength?: number | null;
  insertedText?: string | null;
  insertLength?: number | null;
  deleteDirection?: DeleteDirection | null;
  selectedText?: string | null;
  isSnapshot?: boolean;
}

/** ハッシュ計算に使用するイベントデータ */
export interface EventHashData {
  sequence: number;
  timestamp: number;
  type: EventType;
  inputType: InputType | null;
  data: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | WindowSizeData | NetworkStatusData | SessionResumedData | HumanAttestationEventData | TermsAcceptedData | ScreenshotCaptureData | ScreenShareStartData | ScreenShareStopData | ScreenShareOptOutData | TemplateInjectionEventData | EnvironmentProbeData | FullscreenChangeData | ExamOpenedEventData | null;
  rangeOffset: number | null;
  rangeLength: number | null;
  range: TextRange | null;
  previousHash: string | null;
  posw: PoSWData;  // Proof of Sequential Work
}

/** 保存されるイベントデータ（ハッシュデータ + メタデータ） */
export interface StoredEvent extends EventHashData {
  hash: string;
  description: string | null;
  isMultiLine: boolean | null;
  deletedLength: number | null;
  insertedText: string | null;
  insertLength: number | null;
  deleteDirection: DeleteDirection | null;
  selectedText: string | null;
}

/** イベント記録結果 */
export interface RecordEventResult {
  hash: string;
  index: number;
}

// ============================================================================
// メタデータ
// ============================================================================

/** 証明メタデータ */
export interface ProofMetadata {
  totalEvents: number;
  pasteEvents: number;
  internalPasteEvents: number;
  dropEvents: number;
  insertEvents: number;
  deleteEvents: number;
  /** insertTextなどに紛れた複数文字挿入・一括置換の件数 */
  bulkInsertEvents?: number;
  totalTypingTime: number;
  averageTypingSpeed: number;
}

/** 証明データ */
export interface ProofData {
  finalContentHash: string;
  /** fingerprint hash と組み合わせて initialEventChainHash を再計算するためのnonce */
  initialHashNonce?: string;
  /** イベント列の信頼根。イベントがある場合は event #0.previousHash と一致する */
  initialEventChainHash?: string | null;
  finalEventChainHash: string;
  deviceId: string;
  metadata: ProofMetadata;
}

/** 署名データ */
export interface SignatureData {
  totalEvents: number;
  finalHash: string | null;
  startTime: number;
  endTime: number;
  signature: string;
  events: StoredEvent[];
}

/** タイピング証明ハッシュ生成結果 */
export interface TypingProofHashResult {
  typingProofHash: string;
  proofData: ProofData;
  compact: {
    hash: string;
    content: string;
    isPureTyping: boolean;
    deviceId: string;
    totalEvents: number;
  };
}

/** チェックポイントデータ */
export interface CheckpointData {
  eventIndex: number;     // チェックポイント時点のイベントインデックス
  hash: string;           // その時点のハッシュ値
  timestamp: number;      // その時点のタイムスタンプ
  contentHash: string;    // その時点のコンテンツハッシュ（オプショナル検証用）
  /** 署名済みチェックポイント (Workers 署名サービス由来)。任意 */
  signature?: SignedCheckpointEnvelope;
}

// ============================================================================
// Signed checkpoints
// ============================================================================

// 型本体は types/signedCheckpoint.ts に切り出し済み (browser/DOM 非依存にするため)
export type {
  SignedCheckpointPayload,
  SignedCheckpointAlgorithm,
  SignedCheckpointEnvelope,
  SignedCheckpointVerificationDetail,
  SignedCheckpointsVerificationResult,
} from './signedCheckpoint.js';

import type { SignedCheckpointEnvelope } from './signedCheckpoint.js';

/** エクスポートされる証明ファイル */
export interface ExportedProof {
  version: string;
  typingProofHash: string;
  typingProofData: ProofData;
  proof: SignatureData;
  fingerprint: {
    hash: string;
    components: FingerprintComponents;
  };
  metadata: {
    userAgent: string;
    timestamp: string;
    isPureTyping: boolean;
  };
  checkpoints?: CheckpointData[];  // チェックポイント（v3.2.0以降）
  /** 試験モード (ADR-0006) の束縛ブロック。exam モードで生成された proof のみ持つ */
  exam?: ExamProofBlock;
  /**
   * 生成時のモード (ADR-0011)。**自己申告ラベル**であり信頼判定の根拠にはしない
   * (採点側は実証拠 — exam なら束縛・スクショ有無等 — から保証度を導く)。後方互換のため
   * optional (旧 proof は持たない)。editor の EditorMode と同じ union。
   */
  mode?: 'casual' | 'class' | 'assignment' | 'exam';
}
