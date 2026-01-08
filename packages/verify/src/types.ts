import type { ExportedProof, StoredEvent, InputType, DisplayInfo, ScreenshotCaptureType, HumanAttestation } from '@typedcode/shared';

// Re-export HumanAttestation from shared for backward compatibility
export type { HumanAttestation } from '@typedcode/shared';

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
  // チェーン検証エラーの詳細
  expectedHash?: string;
  computedHash?: string;
  previousTimestamp?: number;
  currentTimestamp?: number;
  totalEvents?: number;
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
  // プレーンテキストファイル（検証対象外）
  isPlaintext?: boolean;
  plaintextContent?: string;
  // 画像ファイル（プレビュー表示用）
  isImage?: boolean;
  imageBlob?: Blob;
  imageUrl?: string;
  // スクリーンショットデータ
  screenshots?: VerifyScreenshot[];
  // 記録開始時刻（チャートX軸表示用）
  startTimestamp?: number;
  // 信頼度計算結果
  trustResult?: TrustResult;
  // 差分比較用フィールド（plaintextファイル専用）
  /** 関連するproofファイルの最終コンテンツ */
  associatedProofContent?: string;
  /** 差分計算結果 */
  diffResult?: DiffResult;
  /** ソースファイルと証明内容が異なるかどうか */
  hasContentMismatch?: boolean;
  // proofファイルに関連付けられたソースファイルの不一致情報
  /** 関連するソースファイルの不一致情報（proofファイル専用） */
  associatedSourceMismatch?: ContentMismatchInfo;
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
  totalEvents?: number; // 全イベント数
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

// ============================================================================
// UI コンポーネント用の型定義
// ============================================================================

/** チェーン検証エラー詳細 */
export interface ChainErrorDetails {
  errorAt: number;              // エラーが発生したイベントインデックス
  errorType: 'sequence' | 'timestamp' | 'previousHash' | 'posw' | 'hash' | 'segmentEnd' | 'unknown';
  message: string;              // エラーメッセージ
  expectedHash?: string;        // 期待されたハッシュ値
  computedHash?: string;        // 計算されたハッシュ値
  previousTimestamp?: number;   // 前のタイムスタンプ（timestamp errorの場合）
  currentTimestamp?: number;    // 現在のタイムスタンプ（timestamp errorの場合）
  totalEvents: number;          // 全イベント数
}

/** サンプリング区間情報（UI表示用） */
export interface SampledSegmentInfo {
  startIndex: number;
  endIndex: number;
  eventCount: number;
  verified: boolean;
}

/** サンプリング検証結果（UI表示用） */
export interface SampledVerificationInfo {
  segments: SampledSegmentInfo[];
  totalSegments: number;
  totalEventsVerified: number;
  totalEvents: number;
}

/** 検証結果（UIコンポーネント用） */
export interface VerificationResult {
  chainValid: boolean;
  pureTyping: boolean;
  pasteCount?: number;
  verificationMethod?: string;
  errorMessage?: string;
  chainErrorDetails?: ChainErrorDetails;  // チェーン検証エラーの詳細
  sampledVerification?: SampledVerificationInfo;  // サンプリング検証の詳細
}

/** PoSW統計（UIコンポーネント用） */
export interface PoswStats {
  totalIterations: number;
  totalTime: number;
  avgTime: number;
}

/** 人間証明（UIコンポーネント用） */
export interface HumanAttestationUI {
  type: 'create' | 'export';
  eventIndex?: number;
  valid: boolean;
  timestamp?: string;
}

// ============================================================================
// File System Access API 関連の型定義
// ============================================================================

/** File System Access API ファイルエントリ */
export interface FSAccessFileEntry {
  handle: FileSystemFileHandle;
  path: string;
  name: string;
  lastModified: number;
}

/** File System Access API フォルダエントリ */
export interface FSAccessFolderEntry {
  handle: FileSystemDirectoryHandle;
  path: string;
  name: string;
}

/** ディレクトリ読み取り結果 */
export interface ReadDirectoryResult {
  success: boolean;
  rootName: string;
  files: FSAccessFileEntry[];
  folders: FSAccessFolderEntry[];
  error?: string;
}

/** 階層フォルダ */
export interface HierarchicalFolder {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  expanded: boolean;
  depth: number;
  sourceType?: 'fsaccess' | 'zip' | 'file';
  directoryHandle?: FileSystemDirectoryHandle;
}

/** ファイル変更イベント */
export interface FileChangeEvent {
  type: 'added' | 'modified' | 'deleted';
  path: string;
  entry: FSAccessFileEntry | null;
}

/** フォルダ変更イベント */
export interface FolderChangeEvent {
  type: 'added' | 'deleted';
  path: string;
  entry: FSAccessFolderEntry | null;
}

/** ファイルスナップショット（変更検知用） */
export interface FileSnapshot {
  path: string;
  lastModified: number;
  handle: FileSystemFileHandle;
}

/** 同期マネージャー コールバック */
export interface SyncManagerCallbacks {
  onFileAdded?: (file: FSAccessFileEntry) => void;
  onFileModified?: (file: FSAccessFileEntry) => void;
  onFileDeleted?: (path: string) => void;
  onFolderAdded?: (path: string, name: string) => void;
  onFolderDeleted?: (path: string) => void;
  onSyncComplete?: () => void;
  onSyncError?: (error: Error) => void;
}

/** FSAccess サービス コールバック */
export interface FSAccessCallbacks {
  onPermissionRequest?: () => void;
  onPermissionGranted?: () => void;
  onPermissionDenied?: (error: Error) => void;
  onReadProgress?: (current: number, total: number) => void;
  onError?: (error: Error) => void;
}

// ============================================================================
// 検証進捗UI用の型定義
// ============================================================================

/** 検証ステップの種類 */
export type VerificationStepType = 'metadata' | 'chain' | 'sampling' | 'complete';

/** 検証ステップの状態 */
export type VerificationStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** 検証ステップの情報 */
export interface VerificationStep {
  type: VerificationStepType;
  status: VerificationStepStatus;
  label: string;
  description: string;
  progress?: number; // 0-100 (ステップ内の進捗)
  detail?: string; // 追加の詳細情報（例: "1,234 / 5,678 イベント"）
  error?: string; // エラーメッセージ
}

/** 検証進捗の全体状態 */
export interface VerificationProgressState {
  filename: string;
  totalProgress: number; // 0-100 (全体の進捗)
  currentStep: VerificationStepType;
  steps: VerificationStep[];
  startTime: number;
  elapsedTime?: number;
}

// ============================================================================
// スクリーンショット検証用の型定義
// ============================================================================

/** スクリーンショットマニフェストエントリ（ZIPから読み込み） */
export interface ScreenshotManifestEntry {
  index: number;
  filename: string;
  imageHash: string;
  captureType: ScreenshotCaptureType;
  eventSequence: number;
  timestamp: number;
  createdAt: number;
  displayInfo: DisplayInfo;
  fileSizeBytes: number;
}

/** スクリーンショットマニフェスト（screenshots/manifest.json） */
export interface ScreenshotManifest {
  version: string;
  exportedAt: string;
  totalScreenshots: number;
  screenshots: ScreenshotManifestEntry[];
}

/** 検証用スクリーンショットデータ */
export interface VerifyScreenshot {
  id: string;
  filename: string;
  imageHash: string;
  captureType: ScreenshotCaptureType;
  eventSequence: number;
  timestamp: number;
  imageUrl: string | null;  // Object URL（遅延読み込み）
  imageBlob: Blob | null;   // 画像データ
  verified: boolean;        // ハッシュ検証結果
  missing?: boolean;        // 画像ファイルが欠損しているか
  tampered?: boolean;       // ハッシュ不一致（ファイルは存在するが改竄の可能性）
  displayInfo: DisplayInfo;
  fileSizeBytes: number;
}

/** 統合チャートキャッシュ（Chart.js用） */
export interface IntegratedChartCache {
  totalTime: number;
  /** 記録開始時刻（Unix timestamp ms） */
  startTimestamp: number;
  events: {
    type: string;
    timestamp: number;
    eventIndex: number;
    data?: unknown;
  }[];
  screenshots: VerifyScreenshot[];
  typingSpeedData: { x: number; y: number }[];
  keystrokeData: {
    dwell: { x: number; y: number; key: string; eventIndex: number }[];
    flight: { x: number; y: number; key: string; eventIndex: number }[];
  };
  focusEvents: StoredEvent[];
  visibilityEvents: StoredEvent[];
  externalInputMarkers: { timestamp: number; type: InputType }[];
  /** 人間検証イベント（ファイル作成時のTurnstile認証） */
  humanAttestationEvents: { timestamp: number; eventIndex: number }[];
  /** 認証系イベント（termsAccepted, preExportAttestation） */
  authEvents: { timestamp: number; eventIndex: number; type: string }[];
  /** システムイベント（editorInitialized, networkStatusChange） */
  systemEvents: { timestamp: number; eventIndex: number; type: string }[];
  /** 実行イベント（codeExecution, terminalInput） */
  executionEvents: { timestamp: number; eventIndex: number; type: string }[];
  /** キャプチャイベント（screenShareStart/Stop, templateInjection） */
  captureEvents: { timestamp: number; eventIndex: number; type: string }[];
  /** ウィンドウリサイズイベント */
  windowResizeEvents: { timestamp: number; eventIndex: number }[];
  /** コンテンツスナップショットイベント */
  contentSnapshotEvents: { timestamp: number; eventIndex: number }[];
  maxSpeed: number;
  maxKeystrokeTime: number;
}

// ============================================================================
// 信頼度表示用の型定義
// ============================================================================

/** 信頼度レベル（3段階） */
export type TrustLevel = 'verified' | 'partial' | 'failed';

/** 信頼度に影響する問題のコンポーネント */
export type TrustIssueComponent = 'metadata' | 'chain' | 'posw' | 'attestation' | 'screenshots' | 'source';

/** 信頼度に影響する問題 */
export interface TrustIssue {
  component: TrustIssueComponent;
  severity: 'error' | 'warning';
  message: string;
}

/** 信頼度計算結果 */
export interface TrustResult {
  level: TrustLevel;
  summary: string;
  issues: TrustIssue[];
}

/** スクリーンショット検証サマリー */
export interface ScreenshotVerificationSummary {
  total: number;
  verified: number;
  missing: number;
  tampered: number;
}

// ============================================================================
// 差分比較用の型定義
// ============================================================================

/** 差分結果 */
export interface DiffResult {
  /** ファイルが同一かどうか */
  isIdentical: boolean;
  /** 差分ハンク */
  hunks: DiffHunk[];
  /** 統計情報 */
  stats: {
    additions: number;
    deletions: number;
    unchanged: number;
  };
}

/** 差分ハンク */
export interface DiffHunk {
  lines: DiffLine[];
}

/** 差分行 */
export interface DiffLine {
  /** 行の種類 */
  type: 'added' | 'removed' | 'unchanged';
  /** 行の内容 */
  content: string;
  /** 元ファイルの行番号（removed/unchanged） */
  oldLineNumber?: number;
  /** 新ファイルの行番号（added/unchanged） */
  newLineNumber?: number;
}

/** ソースファイル不一致情報 */
export interface ContentMismatchInfo {
  filename: string;
  additions: number;
  deletions: number;
}
