/**
 * イベント関連の型定義
 */

// ============================================================================
// 基本イベント型
// ============================================================================

/** イベントタイプ */
export type EventType =
  | 'humanAttestation'  // 人間認証（event #0として記録）
  | 'preExportAttestation'  // エクスポート前認証
  | 'termsAccepted'  // 利用規約同意
  | 'contentChange' // コンテンツ変更
  | 'contentSnapshot' // コンテンツスナップショット
  | 'cursorPositionChange' // カーソル位置変更
  | 'selectionChange' // 選択範囲変更
  | 'externalInput' // 外部入力
  | 'editorInitialized' // エディタ初期化
  | 'mousePositionChange' // マウス位置変更
  | 'visibilityChange' // 表示状態変更
  | 'focusChange' // フォーカス状態変更
  | 'keyDown' // キー押下
  | 'keyUp' // キー離上
  | 'windowResize' // ウィンドウサイズ変更
  | 'networkStatusChange' // ネットワーク状態変更（オンライン/オフライン）
  | 'codeExecution' // コード実行（コンパイル＋実行の開始）
  | 'terminalInput' // ターミナルへの入力（行単位）
  | 'screenshotCapture' // スクリーンショット撮影
  | 'screenShareStart' // 画面共有開始
  | 'screenShareStop' // 画面共有停止
  | 'templateInjection' // テンプレートコンテンツ注入
  | 'sessionResumed' // セッション再開（リロードまたはIndexedDBからの復旧）
  | 'copyOperation' // コピー操作（監査用）
  | 'screenShareOptOut'; // 画面共有オプトアウト

/** 入力タイプ */
export type InputType =
  // 挿入系
  | 'insertText' // テキスト挿入
  | 'insertLineBreak' // 行ブレーク挿入
  | 'insertParagraph' // 段落挿入
  | 'insertTab' // タブ挿入
  | 'insertFromComposition' // 合成入力からの挿入
  | 'insertCompositionText' // 合成入力テキスト挿入
  | 'deleteCompositionText' // 合成入力テキスト削除
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
  // 内部ペースト（許可）
  | 'insertFromInternalPaste'
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
  screenX: number;       // スクリーン座標
  screenY: number;       // スクリーン座標
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

/** ウィンドウサイズデータ */
export interface WindowSizeData {
  width: number;         // window.outerWidth
  height: number;        // window.outerHeight
  innerWidth: number;    // window.innerWidth
  innerHeight: number;   // window.innerHeight
  devicePixelRatio: number;
  screenX: number;       // window.screenX（スクリーン上の位置）
  screenY: number;       // window.screenY（スクリーン上の位置）
}

/** ネットワーク状態データ */
export interface NetworkStatusData {
  online: boolean;       // navigator.onLine
}

/** セッション再開データ */
export interface SessionResumedData {
  timestamp: number;           // 再開時のタイムスタンプ
  previousEventCount: number;  // 再開前のイベント数
  recoveredFromIndexedDB?: boolean;  // IndexedDBからの復旧かどうか
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
