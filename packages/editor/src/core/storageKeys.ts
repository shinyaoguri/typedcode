/**
 * ストレージの名前空間 (ADR-0011 PR3 / #646)。
 *
 * モードはパスで分岐する (ADR-0011) ため、同一 origin で複数モードのセッションが
 * 共存しうる。各モードのセッション (IndexedDB / sessionStorage / 問題キャッシュ) を
 * **モード別に名前空間化**して混在を防ぎ、モード間でセッションを共存させる
 * (PR1/PR2 の「モード切替時 auto-clear」を置換)。
 *
 * **casual は従来名のまま** (サフィックス無し) — 既存ユーザーのセッションを移行不要に保つ。
 * exam/class/assignment はサフィックス `-<mode>` を付ける。これらの旧来の名前空間は #646 の後も
 * そのまま残し、移しも消しもしない (`/` `/casual` `/class` `/assignment` `/exam` で従来どおり開く)。
 *
 * **配布物ごとの作業スペース (#646)**: `/w/class/<classId>/<方針>` は `-w:<作業スペースの名前>`
 * (`core/mode.ts` の `workspaceName`。例 `-w:class:2026-algo-week3:classroom`) を名前空間にする。
 * 旧来の名前空間は `-w:` で始まらないので、どの作業スペースとも重ならない。
 *
 * 使い方: main.ts の最初期に `setStorageNamespace(mode)` (旧来の入口) か
 * `setWorkspaceStorageNamespace(workspace)` (作業スペース) を 1 回呼ぶ。以降、各ストレージ
 * 消費者は **キー literal の代わりに本モジュールの getter を使用時に呼ぶ** (モジュール
 * ロード時に評価される const にしない — NS 確定前に評価されてしまうため)。getter は名前空間を
 * 引数に取れる (省略時は今の名前空間)。別の作業スペースへ移る前に、移り先の領域へ書くとき (#646) に使う。
 */

import { workspaceName, type EditorMode, type WorkspaceRef } from './mode.js';

let ns = '';
let instanceScope = 'casual';

/** 旧来の入口 (`/` `/casual` `/class` `/assignment` `/exam`) の名前空間。casual は '' (従来名)、他は '-<mode>'。 */
export function modeStorageNamespace(mode: EditorMode): string {
  return mode === 'casual' ? '' : `-${mode}`;
}

/** 作業スペース (#646) の名前空間: `-w:<作業スペースの名前>`。 */
export function workspaceStorageNamespace(ref: WorkspaceRef): string {
  return `-w:${workspaceName(ref)}`;
}

/** main.ts の最初期に 1 回呼ぶ (旧来の入口)。casual は '' (従来名)、他は '-<mode>'。 */
export function setStorageNamespace(mode: EditorMode): void {
  ns = modeStorageNamespace(mode);
  instanceScope = mode;
}

/** main.ts の最初期に 1 回呼ぶ (作業スペース。#646)。 */
export function setWorkspaceStorageNamespace(ref: WorkspaceRef): void {
  ns = workspaceStorageNamespace(ref);
  instanceScope = `w:${workspaceName(ref)}`;
}

/** 今の名前空間。 */
export function currentStorageNamespace(): string {
  return ns;
}

/**
 * 二重起動の検出 (`SingleInstanceGuard`) の名前。旧来の入口はモード名のまま (#494 以前から変えない)、
 * 作業スペースは `w:<作業スペースの名前>` (#646)。同じ保存領域を開くタブ同士だけが重複になる。
 */
export function instanceGuardNamespace(): string {
  return instanceScope;
}

/** セッション IndexedDB 名 (tabs/events/screenshots/sessions ストアを含む)。 */
export function sessionDbName(namespace: string = ns): string {
  return `typedcode-session${namespace}`;
}

/** タブ状態の sessionStorage キー。 */
export function tabsKey(namespace: string = ns): string {
  return `typedcode-tabs${namespace}`;
}

/** リロード検出フラグの sessionStorage キー。 */
export function sessionActiveKey(namespace: string = ns): string {
  return `typedcode-session-active${namespace}`;
}

/** 封印問題キャッシュ (localStorage) のキー。 */
export function examPackagesKey(namespace: string = ns): string {
  return `typedcode-exam-packages${namespace}`;
}

/** class 問題キャッシュ (localStorage) のキー (ADR-0014、リロード再表示用)。 */
export function classProblemsKey(namespace: string = ns): string {
  return `typedcode-class-problems${namespace}`;
}

/**
 * 読み込んだ `.tcclass` の方針 (localStorage) のキー (#645)。授業/課題で方針を持つ問題を読み込むと書き、
 * 起動時にこれを入口の能力に重ねる (リロード後も同じ能力で開くため)。作業スペース (#646) では、移る前に
 * 移り先の領域へ書く。
 */
export function classPolicyKey(namespace: string = ns): string {
  return `typedcode-class-policy${namespace}`;
}

/**
 * 作業スペースへ受け渡す、読み込んだ `.tcclass` (sessionStorage) のキー (#646)。移る前に移り先の名前空間で書き、
 * 移り先の起動が読んで消し、問題のタブを開く。sessionStorage はブラウザのタブごとで、同じタブの遷移では残る。
 */
export function pendingClassPackageKey(namespace: string = ns): string {
  return `typedcode-pending-class-package${namespace}`;
}

/**
 * 現在のモードが localStorage に持つキー (リセットの消去対象)。モード共通のキー (規約同意・表示言語・
 * テーマ) は含めない。新しいモード別キーを足したらここにも追加すること (#323)。
 */
export function modeLocalStorageKeys(): readonly string[] {
  return [examPackagesKey(), classProblemsKey(), classPolicyKey()];
}

/** 現在のモードが sessionStorage に持つキー (リセットの消去対象)。足したらここにも追加する (#323)。 */
export function modeSessionStorageKeys(): readonly string[] {
  return [tabsKey(), sessionActiveKey(), pendingClassPackageKey()];
}
