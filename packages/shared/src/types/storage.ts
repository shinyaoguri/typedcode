/**
 * ストレージ・マルチタブ関連の型定義
 */

import type {
  EventType,
  InputType,
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
} from './events.js';
import type {
  ScreenshotCaptureData,
  ScreenShareStartData,
  ScreenShareStopData,
  ScreenShareOptOutData,
} from './screenshot.js';
import type { HumanAttestationEventData, TermsAcceptedData } from './attestation.js';
import type { FingerprintComponents } from './fingerprint.js';
import type {
  StoredEvent,
  ProofData,
  SignatureData,
  CheckpointData,
} from './proof.js';
import type { TemplateInjectionEventData } from './template.js';

/** PendingEvent用のデータ型（RecordEventInput.dataと同等） */
export type PendingEventDataType =
  | string
  | CursorPositionData
  | SelectionData
  | MousePositionData
  | VisibilityChangeData
  | FocusChangeData
  | KeystrokeDynamicsData
  | WindowSizeData
  | NetworkStatusData
  | SessionResumedData
  | HumanAttestationEventData
  | TermsAcceptedData
  | ScreenshotCaptureData
  | ScreenShareStartData
  | ScreenShareStopData
  | ScreenShareOptOutData
  | TemplateInjectionEventData
  | null;

// ============================================================================
// マルチタブ関連
// ============================================================================

/** タブ切り替えイベント */
export interface TabSwitchEvent {
  timestamp: number;
  fromTabId: string | null;
  toTabId: string;
  fromFilename: string | null;
  toFilename: string;
}

/** シリアライズされたプルーフ状態 */
export interface SerializedProofState {
  events: StoredEvent[];
  currentHash: string | null;
  startTime: number;
  /** PoSW計算が完了していないイベント（後方互換性のためオプショナル） */
  pendingEvents?: PendingEventData[];
  /** チェックポイントデータ（サンプリング検証用） */
  checkpoints?: CheckpointData[];
}

/** 認証状態 */
export type VerificationState = 'pending' | 'verified' | 'failed' | 'skipped';

/** 認証詳細情報 */
export interface VerificationDetails {
  timestamp: string;
  failureReason?: string;
}

/** シリアライズされたタブ状態（localStorage用） */
export interface SerializedTabState {
  id: string;
  filename: string;
  language: string;
  content: string;
  proofState: SerializedProofState | null;
  createdAt: number;
  verificationState?: VerificationState;
  verificationDetails?: VerificationDetails;
}

/** マルチタブストレージ構造 */
export interface MultiTabStorage {
  version: 1;
  activeTabId: string;
  tabs: Record<string, SerializedTabState>;
  tabOrder: string[];
  tabSwitches: TabSwitchEvent[];
}

/** マルチファイルエクスポート用ファイルエントリ */
export interface MultiFileExportEntry {
  content: string;
  language: string;
  typingProofHash: string;
  typingProofData: ProofData;
  proof: SignatureData;
}

/** マルチファイルエクスポート形式 */
export interface MultiFileExportedProof {
  version: string;
  type: 'multi-file';
  fingerprint: {
    hash: string;
    components: FingerprintComponents;
  };
  files: Record<string, MultiFileExportEntry>;
  tabSwitches: TabSwitchEvent[];
  metadata: {
    userAgent: string;
    timestamp: string;
    totalFiles: number;
    overallPureTyping: boolean;
  };
}

// ============================================================================
// 検証ページ関連
// ============================================================================

/** シークバー用イベント情報 */
export interface SeekbarEventInfo {
  type: EventType;
  inputType: InputType | null;
  timestamp: number;
  data: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | WindowSizeData | NetworkStatusData | HumanAttestationEventData | ScreenshotCaptureData | ScreenShareStartData | ScreenShareStopData | TemplateInjectionEventData | null;
  dataLength: number;
  dataPreview: string | null;
  rangeOffset: number | null;
  rangeLength: number | null;
  range: TextRange | null;
  description: string | null;
  hash: string;
}

/** コンテンツキャッシュ */
export type ContentCache = Map<number, string>;

// ============================================================================
// IndexedDB セッション永続化関連
// ============================================================================

/** IndexedDBセッションストレージのスキーマバージョン */
export const INDEXEDDB_SESSION_VERSION = 1;

/** セッションメタデータ（IndexedDB格納用） */
export interface SessionMetadata {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  version: number;
  isActive: boolean;
  instanceId: string;
  activeTabId: string;
  tabOrder: string[];
}

/** タブデータ（IndexedDB格納用） */
export interface StoredTabData {
  id: string;
  sessionId: string;
  filename: string;
  language: string;
  content: string;
  createdAt: number;
  lastModifiedAt: number;
  lastWrittenEventIndex: number;
  currentHash: string | null;
  startTime: number;
  verificationState: VerificationState;
  verificationDetails?: VerificationDetails;
  /** チェックポイントデータ（サンプリング検証用） */
  checkpoints?: CheckpointData[];
}

/** イベントデータ（IndexedDB格納用） */
export interface StoredEventData {
  id?: number;
  tabId: string;
  sessionId: string;
  eventIndex: number;
  eventData: StoredEvent;
  writtenAt: number;
}

/** タブ切り替えイベント（IndexedDB格納用） */
export interface StoredTabSwitchData {
  id?: number;
  sessionId: string;
  switchEvent: TabSwitchEvent;
}

/** セッションサマリー（復旧ダイアログ用） */
export interface SessionSummary {
  sessionId: string;
  lastActiveAt: number;
  createdAt: number;
  tabs: TabSummary[];
}

/** タブサマリー（復旧ダイアログ用） */
export interface TabSummary {
  id: string;
  filename: string;
  language: string;
  eventCount: number;
  lastModifiedAt: number;
}

// ============================================================================
// 軽量ストレージ（sessionStorage用、eventsなし、V2フォーマット）
// ============================================================================

/** 軽量プルーフ状態（sessionStorage用、eventsなし） */
export interface LightweightProofState {
  /** 最後のイベントのシーケンス番号 */
  lastEventSequence: number;
  /** 現在のハッシュ */
  currentHash: string | null;
  /** 開始時間 */
  startTime: number;
  /** PoSW計算中のイベント（後方互換性のためオプショナル、復元時は使用しない） */
  pendingEvents?: PendingEventData[];
  /** チェックポイントデータ（サンプリング検証用） */
  checkpoints?: CheckpointData[];
}

/** 軽量タブ状態（sessionStorage用） */
export interface LightweightTabState {
  id: string;
  filename: string;
  language: string;
  /** ファイル内容は保持 */
  content: string;
  /** 軽量プルーフ状態（eventsなし） */
  proofState: LightweightProofState;
  createdAt: number;
  verificationState?: VerificationState;
  verificationDetails?: VerificationDetails;
}

/** 軽量マルチタブストレージ（V2フォーマット） */
export interface LightweightMultiTabStorage {
  version: 2;
  activeTabId: string;
  tabs: Record<string, LightweightTabState>;
  tabOrder: string[];
  tabSwitches: TabSwitchEvent[];
  /** セッションID（IndexedDBとの紐付け用） */
  sessionId: string;
}

// ============================================================================
// Pending Event（PoSW未完了イベント）
// ============================================================================

/** PoSW計算前のイベントデータ */
export interface PendingEventData {
  /** イベントの入力データ（RecordEventInputと同等） */
  input: {
    type: EventType;
    inputType?: InputType | null;
    data?: PendingEventDataType;
    rangeOffset?: number | null;
    rangeLength?: number | null;
    range?: TextRange | null;
    description?: string | null;
    isMultiLine?: boolean | null;
    deletedLength?: number | null;
    insertedText?: string | null;
    insertLength?: number | null;
    deleteDirection?: 'backward' | 'forward' | null;
    selectedText?: string | null;
  };
  /** 記録時のタイムスタンプ（performance.now() - startTime） */
  timestamp: number;
  /** シーケンス番号 */
  sequence: number;
  /** 前のハッシュ（PoSW計算に必要） */
  previousHash: string | null;
  /** タブID */
  tabId: string;
  /** 作成日時（Date.now()） */
  createdAt: number;
}

