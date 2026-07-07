/**
 * イベント関連の型定義
 */

// ============================================================================
// 基本イベント型
// ============================================================================

/** イベントタイプ */
export type EventType =
  | 'humanAttestation' // 人間認証（event #0として記録）
  | 'preExportAttestation' // エクスポート前認証
  | 'termsAccepted' // 利用規約同意
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
  | 'screenShareOptOut' // 画面共有オプトアウト
  | 'reflectionNote' // 提出前セルフレビューの振り返りノート（ADR-0022）
  | 'environmentProbe' // 環境/自動化プローブ（起動時ワンショット, ADR-0007）
  | 'fullscreenChange' // フルスクリーン状態変化（試験モード, ADR-0008）
  | 'examOpened'; // 封印問題パッケージの開封（試験モード, ADR-0006。#1 として記録）

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
  screenX: number; // スクリーン座標
  screenY: number; // スクリーン座標
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
  width: number; // window.outerWidth
  height: number; // window.outerHeight
  innerWidth: number; // window.innerWidth
  innerHeight: number; // window.innerHeight
  devicePixelRatio: number;
  screenX: number; // window.screenX（スクリーン上の位置）
  screenY: number; // window.screenY（スクリーン上の位置）
}

/** ネットワーク状態データ */
export interface NetworkStatusData {
  online: boolean; // navigator.onLine
}

/**
 * editor-assist 宣言（ADR-0019）。
 *
 * 記録セッションでエディタの支援機能（補完・スニペット・括弧自動補完等）が実効的に
 * どう構成されていたかを proof に宣言する。「打鍵で書いた」の境界はエディタ支援の
 * 有効状態に依存するため、検証者がセッション間の前提を比較できるよう事実として残す。
 * 値は Monaco の解決済みオプションから正規化する。取得不可・未知の値は null
 * （graceful absence — 捏造せず「取れなかった」を事実として記録する, ADR-0007）。
 */
export interface EditorAssistDeclaration {
  /** 宣言スキーマ版。将来フィールドを足すときは版を上げる。 */
  schema: 'editor-assist/1';
  /** 入力中の自動候補表示（other/comments/strings のいずれかが有効なら true）。 */
  quickSuggestions: boolean | null;
  /** トリガ文字（`.` 等）での候補表示。 */
  suggestOnTriggerCharacters: boolean | null;
  /** 単語ベース補完（'off' | 'currentDocument' | 'matchingDocuments' | 'allDocuments'）。 */
  wordBasedSuggestions: string | null;
  /** スニペット候補の扱い（'top' | 'bottom' | 'inline' | 'none'）。 */
  snippetSuggestions: string | null;
  /** ゴーストテキスト型のインライン補完（AI 補完系はこの経路に乗る）。 */
  inlineSuggest: boolean | null;
  /** Tab キーでの補完確定（'on' | 'off' | 'onlySnippets'）。 */
  tabCompletion: string | null;
  /** Enter キーでの候補確定（'on' | 'smart' | 'off'）。 */
  acceptSuggestionOnEnter: string | null;
  /** 引数ヒント表示。 */
  parameterHints: boolean | null;
  /** 括弧の自動閉じ（'always' | 'languageDefined' | 'beforeWhitespace' | 'never'）。 */
  autoClosingBrackets: string | null;
  /** クォートの自動閉じ（同上の語彙）。 */
  autoClosingQuotes: string | null;
  /** 選択範囲の自動囲み（'languageDefined' | 'quotes' | 'brackets' | 'never'）。 */
  autoSurround: string | null;
  /** 入力時の自動フォーマット。 */
  formatOnType: boolean | null;
  /** ペースト時の自動フォーマット。 */
  formatOnPaste: boolean | null;
}

/**
 * 振り返りノート（ADR-0022）。
 *
 * 提出前セルフレビューで学生が任意に書く振り返り。チェーンに焼かれるため
 * 改ざん耐性があり、採点者は「本人が提出時に何を述べたか」を信頼できる。
 * 空文字は記録しない（イベント自体を作らない）。
 */
export interface ReflectionNoteData {
  text: string;
}

/**
 * コード実行イベントのデータ（ADR-0021）。
 *
 * 実行は start / result の 2 イベントで記録する（イベントは追記専用のため、開始時に
 * 結果を知り得ない）。旧ビルドの proof は data: null の codeExecution 1 件のみ
 * （= start 相当、結果なし）。「失敗 → 修正 → 成功」のデバッグサイクルは
 * プロセス要約・分析層がこのデータから導出する。
 */
export interface CodeExecutionEventData {
  phase: 'start' | 'result';
  filename: string | null;
  language: string | null;
  /**
   * phase 'result' のみ。
   * - success: 正常終了 (exitCode 0)
   * - failure: 非 0 終了 (コンパイルエラー / 実行時エラーの exit)
   * - error: 実行基盤の例外 (ランタイム破損等)
   * - aborted: ユーザ中断
   */
  outcome?: 'success' | 'failure' | 'error' | 'aborted';
  /** phase 'result' のみ。exit code が得られない経路 (error/aborted) は null。 */
  exitCode?: number | null;
  /** phase 'result' のみ。start からの経過 ms。 */
  elapsedMs?: number;
}

/**
 * 環境/自動化プローブデータ（起動時ワンショット, ADR-0007 Tier 0 B 群の自動化 tell）。
 *
 * fingerprint が既に持つ環境値 (WebGL renderer / hardwareConcurrency 等) は重複させず、
 * fingerprint に無い自動化特化のシグナルだけを捕捉する。分析器 (automation) が本イベントと
 * fingerprint の両方を読む。
 */
export interface EnvironmentProbeData {
  /** navigator.webdriver（自動化ブラウザの強いシグナル）。取得不可は null。 */
  webdriver: boolean | null;
  /** 検出した自動化由来のグローバル名（cdc_*, __playwright 等）。無ければ空配列。 */
  automationGlobals: string[];
  /**
   * editor-assist 宣言（ADR-0019、加算的フィールド）。
   * 旧ビルドの proof には存在しない。プロバイダ未設定・取得失敗は null。
   */
  editorAssist?: EditorAssistDeclaration | null;
}

/**
 * フルスクリーン状態変化データ（試験モード, ADR-0008）。
 *
 * exam モードは fullscreen を要求するが強制しない (非フルスクリーンでも使える)。
 * grant/deny・enter/exit・unavailable を本イベントで全部表現する。非フルスクリーン
 * 滞在時間などは連続イベントのタイムスタンプ差で派生計算する (本体には持たない)。
 */
export interface FullscreenChangeData {
  /** 遷移後の現在状態 (document.fullscreenElement !== null)。 */
  fullscreen: boolean;
  /** Fullscreen API が利用可能か (document.fullscreenEnabled)。graceful absence の事実記録。 */
  available: boolean;
  /** きっかけ: initial=開始時プローブ / request=requestFullscreen()結果 / change=自発遷移(Esc等)。 */
  reason: 'initial' | 'request' | 'change';
  /** reason==='request' のとき grant/deny。それ以外は null。 */
  requestGranted: boolean | null;
}

/**
 * 封印問題パッケージの開封データ（試験モード, ADR-0006 §3）。
 *
 * 監督コード入力 (= T0) で genesis を確定した直後、`humanAttestation` (#0) に続く
 * **#1** として記録する、タイムライン上の可読な監査印。権威ある束縛は proof の root +
 * `proof.exam` が担い、本イベントは「いつ・どの問題を開封したか」を人が読むための印。
 */
export interface ExamOpenedEventData {
  examId: string;
  problemId: string;
  /** per-student variant。v1 運用は単一問題 (null) */
  variant: string | null;
  /** SHA-256(deterministicStringify(signing core)) */
  packageHash: string;
  /** 復号後**平文**問題の SHA-256 */
  problemContentHash: string;
  /** 開封 (= T0) の ISO 時刻 */
  openedAt: string;
}

/** セッション再開データ */
export interface SessionResumedData {
  timestamp: number; // 再開時のタイムスタンプ
  previousEventCount: number; // 再開前のイベント数
  recoveredFromIndexedDB?: boolean; // IndexedDBからの復旧かどうか
}

/** キーストロークダイナミクスデータ */
export interface KeystrokeDynamicsData {
  key: string; // キー名（'a', 'Enter', 'Shift'など）
  code: string; // 物理キーコード（'KeyA', 'Enter', 'ShiftLeft'など）
  keyDownTime?: number; // keydown時刻（performance.now()）
  dwellTime?: number; // キー押下時間（keyUpで設定）
  flightTime?: number; // 前のキーからの経過時間
  modifiers: {
    // 修飾キー状態
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
  /**
   * `KeyboardEvent.isTrusted === false` のとき **だけ** `false` を入れる (ADR-0018)。
   * = JS dispatch (拡張 / ページスクリプト) による合成打鍵。信頼された打鍵では省略するので、
   * 通常タイピングのイベント data は従来とバイト一致する (hash 不変・加算的)。本フィールドは
   * keystroke event の `data` 経由で hash chain に焼かれるため改ざん耐性がある (剥がせない)。
   * **限界**: CDP `Input.dispatchKeyEvent` やハード注入は isTrusted=true なので捕捉できない (部分的)。
   */
  isTrusted?: boolean;
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
