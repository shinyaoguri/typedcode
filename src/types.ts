/**
 * TypedCode - 型定義ファイル
 * プロジェクト全体で使用する共通の型定義
 */

import type * as monaco from 'monaco-editor';

// ============================================================================
// イベント関連の型定義
// ============================================================================

/** イベントタイプ */
export type EventType =
  | 'contentChange'
  | 'contentSnapshot'
  | 'cursorPositionChange'
  | 'selectionChange'
  | 'externalInput'
  | 'editorInitialized'
  | 'mousePositionChange'
  | 'visibilityChange'
  | 'focusChange'
  | 'keyDown'
  | 'keyUp';

/** 入力タイプ（Monaco Editor準拠 + カスタム） */
export type InputType =
  // 挿入系
  | 'insertText'
  | 'insertLineBreak'
  | 'insertParagraph'
  | 'insertTab'
  | 'insertFromComposition'
  | 'insertCompositionText'
  | 'deleteCompositionText'
  // 削除系
  | 'deleteContentBackward'
  | 'deleteContentForward'
  | 'deleteWordBackward'
  | 'deleteWordForward'
  | 'deleteSoftLineBackward'
  | 'deleteSoftLineForward'
  | 'deleteHardLineBackward'
  | 'deleteHardLineForward'
  | 'deleteByDrag'
  | 'deleteByCut'
  // 履歴系
  | 'historyUndo'
  | 'historyRedo'
  // 外部入力（禁止）
  | 'insertFromPaste'
  | 'insertFromDrop'
  | 'insertFromYank'
  | 'insertReplacementText'
  | 'insertFromPasteAsQuotation'
  // その他
  | 'replaceContent';

/** 削除方向 */
export type DeleteDirection = 'forward' | 'backward';

/** テキスト範囲（Monaco Editor準拠） */
export interface TextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** カーソル位置 */
export interface CursorPosition {
  lineNumber: number;
  column: number;
}

/** 選択範囲データ */
export interface SelectionData extends TextRange {}

/** カーソル位置データ */
export interface CursorPositionData extends CursorPosition {}

/** マウス位置データ */
export interface MousePositionData {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

/** Visibility変更データ */
export interface VisibilityChangeData {
  visible: boolean;
  visibilityState: DocumentVisibilityState;
}

/** フォーカス変更データ */
export interface FocusChangeData {
  focused: boolean;
}

/** キーストロークダイナミクスデータ */
export interface KeystrokeDynamicsData {
  key: string;              // キー名（'a', 'Enter', 'Shift'など）
  code: string;             // 物理キーコード（'KeyA', 'Enter', 'ShiftLeft'など）
  keyDownTime?: number;     // keydown時刻（performance.now()）
  dwellTime?: number;       // キー押下時間（keyUpで設定）
  flightTime?: number;      // 前のキーからの経過時間
  modifiers: {              // 修飾キー状態
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
}

/** Proof of Sequential Work データ */
export interface PoSWData {
  iterations: number;       // 反復回数
  nonce: string;            // 計算で使用したnonce
  intermediateHash: string; // 中間ハッシュ（検証用）
  computeTimeMs: number;    // 計算時間（参考値、ミリ秒）
}

// ============================================================================
// TypingProof イベント関連
// ============================================================================

/** イベント記録時の入力データ */
export interface RecordEventInput {
  type: EventType;
  inputType?: InputType | null;
  data?: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | null;
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
  data: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | null;
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
// 検証関連
// ============================================================================

/** ハッシュ検証結果 */
export interface VerificationResult {
  valid: boolean;
  message: string;
  errorAt?: number;
  event?: StoredEvent;
  eventData?: EventHashData;
  expectedHash?: string;
  computedHash?: string;
  previousTimestamp?: number;
  currentTimestamp?: number;
}

/** タイピング証明ハッシュ検証結果 */
export interface TypingProofVerificationResult {
  valid: boolean;
  reason?: string;
  isPureTyping?: boolean;
  deviceId?: string;
  metadata?: ProofMetadata;
}

// ============================================================================
// 証明データ関連
// ============================================================================

/** 証明メタデータ */
export interface ProofMetadata {
  totalEvents: number;
  pasteEvents: number;
  dropEvents: number;
  insertEvents: number;
  deleteEvents: number;
  totalTypingTime: number;
  averageTypingSpeed: number;
}

/** 証明データ */
export interface ProofData {
  finalContentHash: string;
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
}

// ============================================================================
// 統計関連
// ============================================================================

/** イベントタイプ別カウント */
export type EventTypeCounts = Partial<Record<EventType, number>>;

/** 入力タイプ別カウント */
export type InputTypeCounts = Partial<Record<InputType, number>>;

/** 統計情報 */
export interface TypingStats {
  totalEvents: number;
  duration: number;
  eventTypes: EventTypeCounts;
  currentHash: string | null;
}

/** タイピング統計 */
export interface TypingStatistics {
  totalEvents: number;
  pasteEvents: number;
  dropEvents: number;
  insertEvents: number;
  deleteEvents: number;
  duration: number;
  averageWPM: number;
}

// ============================================================================
// フィンガープリント関連
// ============================================================================

/** 画面情報 */
export interface ScreenInfo {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
}

/** WebGL情報 */
export interface WebGLInfo {
  vendor?: string;
  renderer?: string;
  version?: string;
  shadingLanguageVersion?: string;
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  error?: string;
}

/** フィンガープリント構成要素 */
export interface FingerprintComponents {
  userAgent: string;
  language: string;
  languages: readonly string[];
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screen: ScreenInfo;
  timezone: string;
  timezoneOffset: number;
  canvas: string;
  webgl: WebGLInfo;
  fonts: string[];
  cookieEnabled: boolean;
  doNotTrack: string;
  maxTouchPoints: number;
}

/** 安定したブラウザ情報 */
export interface StableInfo {
  userAgent: string;
  platform: string;
  language: string;
  hardwareConcurrency: number;
  timezone: string;
  webglVendor: string;
}

/** 詳細フィンガープリント情報 */
export interface DetailedFingerprint {
  hash: string;
  components: FingerprintComponents;
  timestamp: string;
}

// ============================================================================
// 操作検出関連
// ============================================================================

/** 操作検出結果 */
export interface OperationResult {
  inputType: InputType;
  text: string;
  rangeOffset: number;
  rangeLength: number;
  range: TextRange;
  isMultiLine: boolean;
  deletedLength?: number;
  deleteDirection?: DeleteDirection;
  insertedText?: string;
  insertLength?: number;
}

// ============================================================================
// 入力検出関連
// ============================================================================

/** 検出されたイベントタイプ */
export type DetectedEventType = 'paste' | 'drop' | 'copy';

/** 検出されたイベントデータ */
export interface DetectedEventData {
  text: string;
  length: number;
}

/** 検出されたイベント */
export interface DetectedEvent {
  type: DetectedEventType;
  message: string;
  data: DetectedEventData;
  timestamp: number;
}

/** 検出コールバック */
export type OnDetectedCallback = (event: DetectedEvent) => void;

// ============================================================================
// テーマ関連
// ============================================================================

/** テーマタイプ */
export type Theme = 'light' | 'dark';

// ============================================================================
// Monaco Editor 拡張型
// ============================================================================

/** Monaco Editor インスタンス */
export type MonacoEditor = monaco.editor.IStandaloneCodeEditor;

/** Monaco Editor モデル変更イベント */
export type ModelContentChange = monaco.editor.IModelContentChange;

/** Monaco Editor コンテンツ変更イベント */
export type ModelContentChangedEvent = monaco.editor.IModelContentChangedEvent;

/** Monaco Editor カーソル位置変更イベント */
export type CursorPositionChangedEvent = monaco.editor.ICursorPositionChangedEvent;

/** Monaco Editor 選択変更イベント */
export type CursorSelectionChangedEvent = monaco.editor.ICursorSelectionChangedEvent;

// ============================================================================
// ログビューア関連
// ============================================================================

/** ログ統計 */
export interface LogStats {
  total: number;
  byType: EventTypeCounts;
  byInputType: InputTypeCounts;
}

// ============================================================================
// 検証ページ関連
// ============================================================================

/** シークバー用イベント情報 */
export interface SeekbarEventInfo {
  type: EventType;
  inputType: InputType | null;
  timestamp: number;
  data: string | CursorPositionData | SelectionData | MousePositionData | VisibilityChangeData | FocusChangeData | KeystrokeDynamicsData | null;
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

/** シリアライズされたタブ状態（localStorage用） */
export interface SerializedTabState {
  id: string;
  filename: string;
  language: string;
  content: string;
  proofState: SerializedProofState | null;
  createdAt: number;
}

/** マルチタブストレージ構造 */
export interface MultiTabStorage {
  version: 2;
  activeTabId: string;
  tabs: Record<string, SerializedTabState>;
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
  version: '3.1.0';
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
