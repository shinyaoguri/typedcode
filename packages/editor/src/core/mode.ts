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
 * **配布物ごとの作業スペース (#646)**: `.tcclass` を読み込むと `/w/class/<classId>/<方針>` へ移り、モードは
 * 配布物の方針から決まる (`modeForClassPolicy`)。`/class` `/assignment` `/exam` と `/` は従来の入口のまま残る。
 */

import type { ClassPolicy } from '@typedcode/shared';

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

/**
 * URL パスの先頭セグメントからモードを確定する (editor mode 解決用)。作業スペース (`/w/...`。#646) は
 * その方針から決まるモード (`modeForClassPolicy`)。形の崩れた `/w/...` は entry.ts が not-found にするのでここには来ない。
 */
export function resolveModeFromPath(pathname: string): EditorMode {
  const workspace = parseWorkspacePath(pathname);
  if (workspace) return modeForClassPolicy(workspace.policy);
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
 * ルート (#644。ADR-0015 のランディングを置き換え): エディタモードに加え `'not-found'` を持つ。
 * `/` (と互換の `/casual`) は練習 (casual) のエディタを直接開く。**未知パスは黙って casual にせず**
 * `'not-found'` に落とす — タイポ (`/exsm` 等) で「試験のつもりが練習」になる事故を防ぐ (ADR-0015 から引き継ぐ)。
 */
export type Route = 'not-found' | EditorMode;

/**
 * URL パスの先頭セグメントからルートを確定する。`/`・`/casual` → 'casual'、未知 → 'not-found'。
 * 作業スペース (`/w/...`。#646) は方針から決まるモード、**形の崩れた `/w/...` は 'not-found'** (黙って練習にしない)。
 */
export function resolveRoute(pathname: string): Route {
  if (isWorkspacePrefix(pathname)) {
    const workspace = parseWorkspacePath(pathname);
    return workspace ? modeForClassPolicy(workspace.policy) : 'not-found';
  }
  const seg = pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  switch (seg) {
    case '':
    case 'casual':
      return 'casual';
    case 'class':
      return 'class';
    case 'assignment':
      return 'assignment';
    case 'exam':
      return 'exam';
    default:
      return 'not-found'; // 未知パスはエディタを起動しない
  }
}

export function capabilitiesFor(mode: EditorMode): ModeCapabilities {
  return MODE_CAPABILITIES[mode];
}

// ========================================
// `.tcclass` の方針 (#645)
// ========================================

/** /author で選ぶ方針のプリセット。`classroom` = 教室で実施、`take-home` = 持ち帰り。 */
export type ClassPolicyPreset = 'classroom' | 'take-home';

/** 能力のうち方針が決める 3 つを取り出す。 */
function classPolicyOf(caps: ModeCapabilities): ClassPolicy {
  return {
    screenshots: caps.screenshots,
    fullscreenTracking: caps.fullscreenTracking,
    preExportBestEffort: caps.preExportBestEffort,
  };
}

/**
 * プリセットの方針 (#645)。値は入口の能力から取る: 「教室で実施」= `/class`、「持ち帰り」= `/assignment`。
 * 入口の能力を変えるとプリセット (= /author が書く値) も一緒に変わる。
 */
export const CLASS_POLICY_PRESETS: Readonly<Record<ClassPolicyPreset, Readonly<ClassPolicy>>> = {
  classroom: classPolicyOf(CLASS),
  'take-home': classPolicyOf(ASSIGNMENT),
};

/** 方針を持つ `.tcclass` を読み込むモードか (平文の問題を読み込む授業/課題だけ。試験・練習は方針を見ない)。 */
export function acceptsClassPolicy(mode: EditorMode): boolean {
  const caps = MODE_CAPABILITIES[mode];
  return caps.problemPanel && !caps.sealedProblem;
}

/**
 * 入口 (`mode`) の能力に、読み込んだ `.tcclass` の方針を重ねた実効の能力 (#645)。
 * 方針が無い (旧ファイル・未読込) ときは入口の能力そのまま。方針は 3 つの能力を上書きし、
 * 起動時の画面共有の勧誘はスクリーンショットを撮るときだけ出す (class / assignment の現行値と一致する)。
 * 方針を受け付けないモード (`acceptsClassPolicy` が偽) では方針を無視する。
 */
export function capabilitiesWithPolicy(mode: EditorMode, policy: ClassPolicy | null): ModeCapabilities {
  const base = MODE_CAPABILITIES[mode];
  if (!policy || !acceptsClassPolicy(mode)) return base;
  return {
    ...base,
    screenshots: policy.screenshots,
    promptScreenShareAtStart: policy.screenshots,
    fullscreenTracking: policy.fullscreenTracking,
    preExportBestEffort: policy.preExportBestEffort,
  };
}

// ========================================
// 配布物ごとの作業スペース (#646)
// ========================================

/**
 * 授業 / 課題の作業スペース (#646)。`.tcclass` を読み込むと、その配布物の **classId と方針** で決まる
 * 作業スペースへ移る (保存領域が配布物ごとに分かれ、練習や別の配布物のタブと混ざらない)。
 * 同じ classId・同じ方針なら同じ作業スペース (改訂は問題文だけを差し替える)、方針が違えば別の作業スペース。
 */
export interface ClassWorkspace {
  readonly kind: 'class';
  readonly classId: string;
  readonly policy: ClassPolicy;
}

/**
 * 試験の作業スペースの名前の材料 (#889 で使う。今は名前の導出だけで、ルートも保存領域も持たない)。
 * 種別 (`exam:`) を名前の先頭に置くので、/author が examId を classId に流用しても `.tcclass` の作業スペースと混ざらない。
 */
export interface ExamWorkspaceRef {
  readonly kind: 'exam';
  readonly examId: string;
  readonly variant?: string;
}

/** 作業スペースの名前の材料 (種別ごと)。 */
export type WorkspaceRef = ClassWorkspace | ExamWorkspaceRef;

/** URL の 1 段目 (`/w/...`)。 */
const WORKSPACE_PATH_SEGMENT = 'w';

const CUSTOM_POLICY_CODE = /^custom-([01])([01])([01])$/;

function samePolicy(a: ClassPolicy, b: ClassPolicy): boolean {
  return (
    a.screenshots === b.screenshots &&
    a.fullscreenTracking === b.fullscreenTracking &&
    a.preExportBestEffort === b.preExportBestEffort
  );
}

/** 方針がプリセットのどれかと一致すればその名前 (無ければ null)。 */
function presetOf(policy: ClassPolicy): ClassPolicyPreset | null {
  if (samePolicy(policy, CLASS_POLICY_PRESETS.classroom)) return 'classroom';
  if (samePolicy(policy, CLASS_POLICY_PRESETS['take-home'])) return 'take-home';
  return null;
}

/**
 * 方針を URL と保存領域の名前に使う短い符号にする: プリセットなら `classroom` / `take-home`、それ以外は
 * `custom-<s><f><b>` (スクリーンショット・フルスクリーンの記録・export 前認証の best-effort を 0/1 で)。
 */
export function classPolicyCode(policy: ClassPolicy): string {
  const preset = presetOf(policy);
  if (preset) return preset;
  const bit = (v: boolean): string => (v ? '1' : '0');
  return `custom-${bit(policy.screenshots)}${bit(policy.fullscreenTracking)}${bit(policy.preExportBestEffort)}`;
}

/**
 * `classPolicyCode` の逆。知らない符号や、プリセットと同じ値を `custom-` で書いた符号 (1 つの方針の URL を 1 つに
 * 保つため) は null。
 */
export function parseClassPolicyCode(code: string): ClassPolicy | null {
  if (code === 'classroom' || code === 'take-home') return { ...CLASS_POLICY_PRESETS[code] };
  const m = CUSTOM_POLICY_CODE.exec(code);
  if (!m) return null;
  const policy: ClassPolicy = {
    screenshots: m[1] === '1',
    fullscreenTracking: m[2] === '1',
    preExportBestEffort: m[3] === '1',
  };
  return classPolicyCode(policy) === code ? policy : null;
}

/**
 * 作業スペースの `proof.mode` (#646 の決定 5): 方針が「教室で実施」なら `class`、「持ち帰り」なら `assignment`。
 * プリセットに無い組み合わせは、スクリーンショットを撮るなら `class`、撮らないなら `assignment`。
 */
export function modeForClassPolicy(policy: ClassPolicy): 'class' | 'assignment' {
  const preset = presetOf(policy);
  if (preset === 'classroom') return 'class';
  if (preset === 'take-home') return 'assignment';
  return policy.screenshots ? 'class' : 'assignment';
}

/**
 * classId を URL のパスの 1 段に置けるか。`.` と `..` は符号化してもブラウザがパスの `.` / `..` として畳むので置けない
 * (それ以外は `encodeURIComponent` で 1 段に収まる)。
 */
export function isRoutableClassId(classId: string): boolean {
  return classId !== '' && classId !== '.' && classId !== '..';
}

/**
 * 作業スペースの名前 (保存領域と二重起動の検出に使う)。種別を先頭に置き、`class:<classId>:<方針の符号>` /
 * `exam:<examId>[:<variant>]`。各部分は `encodeURIComponent` で符号化するので、区切りの `:` は部分の中に現れず、
 * どの部分に何が入っても別の作業スペースと同じ名前にならない。
 */
export function workspaceName(ref: WorkspaceRef): string {
  const enc = encodeURIComponent;
  if (ref.kind === 'class') return `class:${enc(ref.classId)}:${classPolicyCode(ref.policy)}`;
  return ref.variant === undefined ? `exam:${enc(ref.examId)}` : `exam:${enc(ref.examId)}:${enc(ref.variant)}`;
}

/** 作業スペースの URL のパス: `/w/class/<encodeURIComponent(classId)>/<方針の符号>`。 */
export function classWorkspacePath(ws: ClassWorkspace): string {
  return `/${WORKSPACE_PATH_SEGMENT}/class/${encodeURIComponent(ws.classId)}/${classPolicyCode(ws.policy)}`;
}

/**
 * パスが作業スペースの URL ならその作業スペース。`/w/` で始まらないパスと、形の崩れた `/w/...`
 * (段の数・種別・符号化・方針の符号の誤り) は null。末尾の `/` は 1 つだけ許す。
 */
export function parseWorkspacePath(pathname: string): ClassWorkspace | null {
  const segs = pathname.replace(/^\/+/, '').split('/');
  if (segs.length === 5 && segs[4] === '') segs.pop();
  if (segs.length !== 4) return null;
  const [first, kind, rawClassId, code] = segs as [string, string, string, string];
  if (first.toLowerCase() !== WORKSPACE_PATH_SEGMENT || kind !== 'class') return null;
  let classId: string;
  try {
    classId = decodeURIComponent(rawClassId);
  } catch {
    return null; // 壊れた % 符号
  }
  if (!isRoutableClassId(classId)) return null;
  const policy = parseClassPolicyCode(code);
  return policy ? { kind: 'class', classId, policy } : null;
}

/** パスが `/w/...` (作業スペースの URL の形をしているか。中身の正しさは問わない)。 */
function isWorkspacePrefix(pathname: string): boolean {
  return pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() === WORKSPACE_PATH_SEGMENT;
}

/**
 * 問題を読み込む入口の既定の方針 (#646 の決定 4)。方針の無い (旧) `.tcclass` はこれで開く:
 * 作業スペースの中ならその作業スペースの方針、`/class` は「教室で実施」、`/assignment` と練習 (`/`) は「持ち帰り」。
 */
export function entranceClassPolicy(mode: EditorMode, workspace: ClassWorkspace | null): ClassPolicy {
  if (workspace) return { ...workspace.policy };
  return { ...CLASS_POLICY_PRESETS[mode === 'class' ? 'classroom' : 'take-home'] };
}

/** 読み込んだ `.tcclass` を開く作業スペース。方針は配布物の方針、無ければ入口の既定 (`entranceClassPolicy`)。 */
export function classWorkspaceFor(
  pkg: { readonly classId: string; readonly policy?: ClassPolicy | undefined },
  mode: EditorMode,
  workspace: ClassWorkspace | null
): ClassWorkspace {
  return {
    kind: 'class',
    classId: pkg.classId,
    policy: pkg.policy ? { ...pkg.policy } : entranceClassPolicy(mode, workspace),
  };
}

/** 2 つの作業スペースが同じか (同じ名前 = 同じ保存領域)。 */
export function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return workspaceName(a) === workspaceName(b);
}
