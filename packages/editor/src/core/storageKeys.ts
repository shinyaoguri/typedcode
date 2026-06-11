/**
 * モード別のストレージ名前空間 (ADR-0011 PR3)。
 *
 * モードはパスで分岐する (ADR-0011) ため、同一 origin で複数モードのセッションが
 * 共存しうる。各モードのセッション (IndexedDB / sessionStorage / 問題キャッシュ) を
 * **モード別に名前空間化**して混在を防ぎ、モード間でセッションを共存させる
 * (PR1/PR2 の「モード切替時 auto-clear」を置換)。
 *
 * **casual は従来名のまま** (サフィックス無し) — 既存ユーザーのセッションを移行不要に保つ。
 * exam/class/assignment はサフィックス `-<mode>` を付ける。
 *
 * 使い方: main.ts の最初期に `setStorageNamespace(mode)` を 1 回呼ぶ。以降、各ストレージ
 * 消費者は **キー literal の代わりに本モジュールの getter を使用時に呼ぶ** (モジュール
 * ロード時に評価される const にしない — NS 確定前に評価されてしまうため)。
 */

import type { EditorMode } from './mode.js';

let ns = '';

/** main.ts の最初期に 1 回呼ぶ。casual は '' (従来名)、他は '-<mode>'。 */
export function setStorageNamespace(mode: EditorMode): void {
  ns = mode === 'casual' ? '' : `-${mode}`;
}

/** セッション IndexedDB 名 (tabs/events/screenshots/sessions ストアを含む)。 */
export function sessionDbName(): string {
  return `typedcode-session${ns}`;
}

/** タブ状態の sessionStorage キー。 */
export function tabsKey(): string {
  return `typedcode-tabs${ns}`;
}

/** リロード検出フラグの sessionStorage キー。 */
export function sessionActiveKey(): string {
  return `typedcode-session-active${ns}`;
}

/** 封印問題キャッシュ (localStorage) のキー。 */
export function examPackagesKey(): string {
  return `typedcode-exam-packages${ns}`;
}

/** class 問題キャッシュ (localStorage) のキー (ADR-0014、リロード再表示用)。 */
export function classProblemsKey(): string {
  return `typedcode-class-problems${ns}`;
}

/**
 * 全モードのセッション IndexedDB 名 (?reset の全消去用)。legacy `typedcode-screenshots`
 * も含める。新しいモードを足したらここにも追加すること。
 */
export function allSessionDbNames(): readonly string[] {
  return [
    'typedcode-session',
    'typedcode-session-class',
    'typedcode-session-assignment',
    'typedcode-session-exam',
    'typedcode-screenshots', // legacy (現在はセッション DB の screenshots ストアを使用)
  ];
}
