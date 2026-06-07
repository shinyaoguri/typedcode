/**
 * モードルーティングと能力モデル (ADR-0011)。
 *
 * TypedCode は演習授業の全工程で使う: casual(素のエディタ) / class(授業) /
 * assignment(課題) / exam(試験)。**モードは URL パスから確定**する
 * (`/exam` `/class` `/assignment`、他は casual)。sticky フラグは持たない
 * (path はリロードで永続するため)。試験の整合性は封印パッケージの暗号束縛 (ADR-0006)
 * が担保するので、モードに「閉じ込める」必要はない。
 *
 * PR1 (本コミット): routing + モデル + exam を path 化 + proof に mode 記録。
 * **class/assignment はルーティングと能力定義のみ (挙動は当面 casual 同等)**。能力差の
 * 実配線 (課題スクショ off 等) と per-mode storage 名前空間化は後続 PR。
 */

export type EditorMode = 'casual' | 'class' | 'assignment' | 'exam';

/** proof に記録する mode 文字列 (shared の ExportedProof.mode と一致させる) */
export const ALL_EDITOR_MODES: readonly EditorMode[] = ['casual', 'class', 'assignment', 'exam'];

/** モードごとの能力 (単一の真実源)。PR1 では exam の差分のみ実配線。 */
export interface ModeCapabilities {
  /** 封印問題 + 監督コード + 根束縛 (ExamStartGate)。exam のみ。 */
  sealedProblem: boolean;
  /** スクリーンショット捕捉を許すか。 */
  screenshots: boolean;
  /** フルスクリーン要求/記録 (ADR-0008)。 */
  fullscreenTracking: boolean;
  /** タブの追加/削除を源流ロック (ADR-0010)。 */
  tabLock: boolean;
  /** 左の汎用 DL メニューを隠し、問題パネルの DL に一本化する。 */
  unifyDownloadToProblemPanel: boolean;
  /** 問題パネル (問題表示 + ログ DL)。 */
  problemPanel: boolean;
  /** export 前 Turnstile を best-effort 化 (サーバを critical path に置かない)。 */
  preExportBestEffort: boolean;
}

const CASUAL: ModeCapabilities = {
  sealedProblem: false,
  screenshots: true,
  fullscreenTracking: false,
  tabLock: false,
  unifyDownloadToProblemPanel: false,
  problemPanel: false,
  preExportBestEffort: false,
};

const EXAM: ModeCapabilities = {
  sealedProblem: true,
  screenshots: true,
  fullscreenTracking: true,
  tabLock: true,
  unifyDownloadToProblemPanel: true,
  problemPanel: true,
  preExportBestEffort: true,
};

/**
 * 能力マトリクス (ADR-0011)。
 *
 * **class/assignment の値は当面 casual と同一 (PR1 では非アクティブ)**。PR2 で授業/課題の
 * 能力に差し替える予定:
 *   - class      → 監督下・封印なし (screenshots 任意, fullscreen 任意, tabLock 緩, problemPanel)
 *   - assignment → 持ち帰り (screenshots:false=スクショ off, fullscreen:false, problemPanel, preExportBestEffort)
 */
export const MODE_CAPABILITIES: Record<EditorMode, ModeCapabilities> = {
  casual: CASUAL,
  class: CASUAL,
  assignment: CASUAL,
  exam: EXAM,
};

/** URL パスの先頭セグメントからモードを確定する。 */
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

export function capabilitiesFor(mode: EditorMode): ModeCapabilities {
  return MODE_CAPABILITIES[mode];
}
