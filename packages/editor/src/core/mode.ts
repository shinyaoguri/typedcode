/**
 * モードルーティングと能力モデル (ADR-0011)。
 *
 * TypedCode は演習授業の全工程で使う: casual(素のエディタ) / class(授業) /
 * assignment(課題) / exam(試験)。**モードは URL パスから確定**する
 * (`/exam` `/class` `/assignment`、他は casual)。sticky フラグは持たない
 * (path はリロードで永続するため)。試験の整合性は封印パッケージの暗号束縛 (ADR-0006)
 * が担保するので、モードに「閉じ込める」必要はない。
 *
 * 実装状況 (ADR-0011 PR1–3, develop マージ済み): routing + 能力モデル + exam の path 化 +
 * proof への mode 記録、能力差の実配線 (assignment はスクショ off 等)、storage のモード別
 * 名前空間化 (core/storageKeys.ts) まで完了。
 * **class 固有の能力 (ADR-0014)**: 問題表示 (problemPanel) + 受動的 fullscreen 記録
 * (fullscreenTracking + fullscreenBanner=false) を実装。問題は平文 `.tcclass` で配布
 * (tier ① 自己申告、封印なし・root 束縛なし)。監督は教室の物理在室で担保。
 * **未実装の繰り越し**: assignment 固有の問題配布 UX、per-student variant (tier ② 署名記述子)。
 */

export type EditorMode = 'casual' | 'class' | 'assignment' | 'exam';

/** proof に記録する mode 文字列 (shared の ExportedProof.mode と一致させる) */
export const ALL_EDITOR_MODES: readonly EditorMode[] = ['casual', 'class', 'assignment', 'exam'];

/** モードごとの能力 (単一の真実源)。全フラグが各消費者で実配線済み (ADR-0011 PR2)。 */
export interface ModeCapabilities {
  /** 封印問題 + 監督コード + 根束縛 (ExamStartGate)。exam のみ。 */
  sealedProblem: boolean;
  /** スクリーンショット捕捉を許すか。 */
  screenshots: boolean;
  /** スクリーンショットを起動時に勧誘 (画面共有ダイアログ) するか。
   *  false でも screenshots が真なら tracker は作られ、後からバナーでオプトイン可能 (ADR-0015)。 */
  promptScreenShareAtStart: boolean;
  /** フルスクリーン状態を記録するか (ADR-0008)。 */
  fullscreenTracking: boolean;
  /**
   * 非フルスクリーン時に警告バナー + 「フルスクリーンで受験」要求ボタンを出すか。
   * exam は要求 (true)、class は受動記録のみ (false, ADR-0014)。
   */
  fullscreenBanner: boolean;
  /** タブの追加/削除を源流ロック (ADR-0010)。 */
  tabLock: boolean;
  /** 左の汎用 DL メニューを隠し、問題パネルの DL に一本化する。 */
  unifyDownloadToProblemPanel: boolean;
  /** 問題パネル (問題表示 + ログ DL)。 */
  problemPanel: boolean;
  /** export 前 Turnstile を best-effort 化 (サーバを critical path に置かない)。 */
  preExportBestEffort: boolean;
  /**
   * 提出前セルフレビュー (ADR-0022): export 時に自分のプロセス要約を確認し、
   * 任意の振り返りノートをチェーンへ記録するステップを出すか。
   * exam は時間圧迫を避けて off (記録自体は他モードと同一フォーマット)。
   */
  selfReview: boolean;
}

/**
 * 通常モード (casual): 素のエディタ・個人/デモ・**最低保証** (ADR-0015)。
 * スクショは使える (screenshots:true) が**起動時に勧誘しない** (promptScreenShareAtStart:false) —
 * オプトアウト状態で始まり、バナーから後で有効化できる。利用規約モーダルも出さない (main.ts 側で分岐)。
 */
const CASUAL: ModeCapabilities = {
  sealedProblem: false,
  screenshots: true,
  promptScreenShareAtStart: false,
  fullscreenTracking: false,
  fullscreenBanner: false,
  tabLock: false,
  unifyDownloadToProblemPanel: false,
  problemPanel: false,
  preExportBestEffort: false,
  selfReview: true,
};

const EXAM: ModeCapabilities = {
  sealedProblem: true,
  screenshots: true,
  promptScreenShareAtStart: true,
  fullscreenTracking: true,
  fullscreenBanner: true,
  tabLock: true,
  unifyDownloadToProblemPanel: true,
  problemPanel: true,
  preExportBestEffort: true,
  selfReview: false,
};

/**
 * 授業モード (class): 監督下だが**封印しない** (問題は公開。ADR-0011 §3 / ADR-0014)。
 * casual に対し **問題表示** (problemPanel) と **受動的 fullscreen 記録** (fullscreenTracking、
 * ただし要求バナーは出さない = fullscreenBanner:false) を足す。タブは緩 (tabLock:false)、
 * 汎用 DL も残す (unify:false)。教室・多人数・不安定網ゆえ export は best-effort 化する。
 * 問題は平文 `.tcclass` で配布し root 束縛は持たない (tier ① 自己申告)。
 */
const CLASS: ModeCapabilities = {
  sealedProblem: false,
  screenshots: true,
  promptScreenShareAtStart: true,
  fullscreenTracking: true,
  fullscreenBanner: false,
  tabLock: false,
  unifyDownloadToProblemPanel: false,
  problemPanel: true,
  preExportBestEffort: true,
  selfReview: true,
};

/**
 * 課題モード (assignment): 持ち帰り・プライバシー重視。CASUAL から **screenshots を off** に
 * する (自宅画面のキャプチャを避ける。ADR-0011)。封印なし。**問題パネルは持つ** (ADR-0015) —
 * 平文 `.tcclass` を「問題を読み込む」からいつでも取り込める (class と同じ非封印 tier ①)。
 */
const ASSIGNMENT: ModeCapabilities = { ...CASUAL, screenshots: false, problemPanel: true };

/**
 * 能力マトリクス (ADR-0011 / ADR-0014)。
 *
 * - **class は問題表示 + 受動 fullscreen** を持つ (監督は教室の物理在室で担保。封印なし)。
 * - **assignment は screenshots off** (プライバシー)。
 * - **exam** だけが封印問題・根束縛・厳格な能力 (tabLock/fullscreen 要求/preExport best-effort) を持つ。
 */
export const MODE_CAPABILITIES: Record<EditorMode, ModeCapabilities> = {
  casual: CASUAL,
  class: CLASS,
  assignment: ASSIGNMENT,
  exam: EXAM,
};

/** URL パスの先頭セグメントからモードを確定する (editor mode 解決用)。 */
export function resolveModeFromPath(pathname: string): EditorMode {
  const seg = pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  switch (seg) {
    case 'exam':
      return 'exam';
    case 'class':
      return 'class';
    case 'assignment':
      return 'assignment';
    default:
      return 'casual';
  }
}

/**
 * ルート (ADR-0015): エディタモードに加え `'landing'` を持つ。`/` と**未知パス**は
 * `'landing'`(モードを選ぶ入口)に落とす — 黙って casual にせず、タイポ (`/exsm` 等) で
 * 「試験のつもりが casual」事故を防ぐ。casual は明示ルート `/casual` でのみ入る。
 */
export type Route = 'landing' | EditorMode;

/** URL パスの先頭セグメントからルートを確定する。`/`・未知 → 'landing'。 */
export function resolveRoute(pathname: string): Route {
  const seg = pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  switch (seg) {
    case 'casual':
      return 'casual';
    case 'class':
      return 'class';
    case 'assignment':
      return 'assignment';
    case 'exam':
      return 'exam';
    default:
      return 'landing'; // 空 (ルート /) と未知パスは入口へ
  }
}

export function capabilitiesFor(mode: EditorMode): ModeCapabilities {
  return MODE_CAPABILITIES[mode];
}
