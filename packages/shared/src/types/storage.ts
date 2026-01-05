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
} from './events.js';
import type {
  ScreenshotCaptureData,
  ScreenShareStartData,
  ScreenShareStopData,
} from './screenshot.js';
import type { HumanAttestationEventData } from './attestation.js';
import type { FingerprintComponents } from './fingerprint.js';
import type {
  StoredEvent,
  ProofData,
  SignatureData,
} from './proof.js';
import type { TemplateInjectionEventData } from './template.js';

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
  version: 3;
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
