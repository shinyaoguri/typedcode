import type { ExportedProof, StoredEvent, InputType } from '@typedcode/shared';

/**
 * 署名付き人間証明書（サーバーが発行、改竄不可）
 */
export interface HumanAttestation {
  verified: boolean;
  score: number;
  action: string;
  timestamp: string;
  hostname: string;
  signature: string;
}

// Extended proof data with content and language
export interface ProofFile extends ExportedProof {
  content: string;
  language: string;
  humanAttestation?: HumanAttestation;
}

// Content cache type
export type ContentCache = Map<number, string>;

// Loading log state
export interface LoadingLog {
  container: HTMLElement | null;
  logList: HTMLElement | null;
  startTime: number;
}

// Mouse trajectory cache
export interface MouseTrajectoryCache {
  positions: { x: number; y: number; time: number; eventIndex: number }[];
  scale: number;
  padding: { top: number; right: number; bottom: number; left: number };
  maxX: number;
  maxY: number;
  // スクリーン座標系の範囲（ウィンドウ枠描画用）
  minScreenX: number;
  minScreenY: number;
  windowRects: { x: number; y: number; width: number; height: number; time: number }[];
}

// Integrated timeline cache
export interface IntegratedTimelineCache {
  totalTime: number;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
  typingSpeedData: { time: number; speed: number }[];
  externalInputMarkers: { time: number; type: InputType }[];
  focusEvents: StoredEvent[];
  visibilityEvents: StoredEvent[];
  keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[];
  keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[];
  maxSpeed: number;
  maxKeystrokeTime: number;
}

// External input marker
export interface ExternalInputMarker {
  time: number;
  type: InputType;
}

// ============================================================================
// 検証ページ マルチタブ対応の型定義
// ============================================================================

/** 検証ステータス */
export type VerificationStatus = 'pending' | 'verifying' | 'success' | 'warning' | 'error';

/** 検証結果データ（Worker→メインスレッドへ渡すデータ） */
export interface VerificationResultData {
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  message?: string;
  errorAt?: number;
  // PoSW統計
  poswStats?: {
    count: number;
    avgTimeMs: number;
    totalTimeMs: number;
    iterations: number;
  };
  // サンプリング検証結果
  sampledResult?: {
    sampledSegments: Array<{
      startIndex: number;
      endIndex: number;
      eventCount: number;
      startHash: string;
      endHash: string;
      verified: boolean;
    }>;
    totalSegments: number;
    totalEventsVerified: number;
    totalEvents: number;
  };
}

/** 詳細な進捗情報 */
export interface ProgressDetails {
  phase: string;           // 現在のフェーズ（metadata, chain, complete）
  current: number;         // 現在の進捗（例: 検証済みイベント数）
  total: number;           // 全体数（例: 総イベント数）
  totalEvents?: number;    // 総イベント数
  totalSegments?: number;  // チェックポイント区間数
  sampledSegments?: number; // サンプリング対象区間数
  currentSegment?: number; // 現在検証中の区間
  eventsVerified?: number; // 検証済みイベント数
}

/** 検証タブの状態 */
export interface VerifyTabState {
  id: string;
  filename: string;
  language: string;
  status: VerificationStatus;
  progress: number;  // 0-100
  progressPhase?: string;  // 現在のフェーズ（metadata, chain, etc.）
  progressDetails?: ProgressDetails;  // 詳細な進捗情報
  proofData: ProofFile | null;
  verificationResult: VerificationResultData | null;
  // 人間証明書検証結果（メインスレッドで実行）
  humanAttestationResult?: {
    createValid?: boolean;
    exportValid?: boolean;
    hasAttestation: boolean;
  };
  error?: string;
}

/** キューアイテム */
export interface QueueItem {
  id: string;
  filename: string;
  rawData: string;
}

/** Worker メッセージ: メインスレッド→Worker */
export interface WorkerRequestMessage {
  type: 'verify';
  id: string;
  proofData: ProofFile;
}

/** Worker メッセージ: Worker→メインスレッド */
export interface WorkerResponseMessage {
  type: 'progress' | 'result' | 'error';
  id: string;
  // progress
  current?: number;
  total?: number;
  phase?: string;
  hashInfo?: { computed: string; expected: string; poswHash?: string };
  // result
  result?: VerificationResultData;
  // error
  error?: string;
}

// ============================================================================
// 新規追加: リファクタリング用の型定義
// ============================================================================

/** ファイル処理モード */
export type FileProcessMode = 'single' | 'multi';

/** UI表示状態 */
export type UIDisplayState = 'dropzone' | 'loading' | 'result' | 'error';

/** パネル表示設定 */
export interface PanelVisibility {
  metadata: boolean;
  chain: boolean;
  posw: boolean;
  attestation: boolean;
  externalInput: boolean;
  charts: boolean;
}

/** デフォルトのパネル表示設定 */
export const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  metadata: true,
  chain: true,
  posw: true,
  attestation: true,
  externalInput: true,
  charts: true,
};
