/**
 * 状態契約 (packages/editor/AGENTS.md「状態契約」) のうち、DOM の 1 要素に閉じないもの。
 *
 * - `html[data-app-state]`: アプリの段階
 * - `window.__tcTestSnapshot` (dev 限定): E2E が DOM の契約と突き合わせる内部状態の写し
 *
 * E2E は翻訳テキストや CSS クラスではなくこれを読む (ADR-0034)。値や形を変えるときは
 * packages/e2e の読み手 (`tests/helpers/app.ts` の `EditorApp`) と同じ PR で変える。
 */

import type { TabState } from '../ui/tabs/TabManager.js';
import { tabFullFilename } from '../ui/tabs/TabUIController.js';

/**
 * アプリの段階。
 * - `initializing`: 起動処理中 (利用規約・画面共有の選択・復旧ダイアログもここに含む)
 * - `landing`: モード選択のランディング (`/` と未知パス。エディタは初期化しない)
 * - `gate`: 試験のスタートゲート (`ExamStartGate`) で解錠を待っている
 * - `ready`: 編集できる状態 (タブ 0 本のウェルカム画面を含む)
 *
 * 起動を途中で止める画面 (別タブで起動中・未対応ブラウザ・認証失敗) では `initializing` のまま残る。
 * 何で止まったかは `data-dialog` で見る。
 */
export type AppState = 'initializing' | 'landing' | 'gate' | 'ready';

export function setAppState(state: AppState, root: HTMLElement = document.documentElement): void {
  root.dataset.appState = state;
}

export function getAppState(root: HTMLElement = document.documentElement): AppState | null {
  return (root.dataset.appState as AppState | undefined) ?? null;
}

/** `__tcTestSnapshot` のタブ 1 本分。filename は DOM の `data-filename` と同じ拡張子込みの名前。 */
export interface TestSnapshotTab {
  id: string;
  filename: string;
  language: string;
  content: string;
  totalEvents: number;
  pendingCount: number;
  currentHash: string | null;
}

export interface TestSnapshot {
  appState: AppState | null;
  /** アクティブなタブの id。タブが 0 本なら null */
  activeTabId: string | null;
  /** 表示順 (`TabManager.getAllTabs()` = tabOrder 順) */
  tabs: TestSnapshotTab[];
}

/** スナップショットの材料。TabManager の一部だけを要求してテストで差し替えられるようにする */
export interface SnapshotSource {
  getAllTabs(): Pick<TabState, 'id' | 'filename' | 'language' | 'model' | 'typingProof'>[];
  getActiveTab(): Pick<TabState, 'id'> | null;
}

export function buildTestSnapshot(source: SnapshotSource | null, appState: AppState | null): TestSnapshot {
  const tabs = (source?.getAllTabs() ?? []).map((tab): TestSnapshotTab => {
    const stats = tab.typingProof.getStats();
    return {
      id: tab.id,
      filename: tabFullFilename(tab),
      language: tab.language,
      content: tab.model.getValue(),
      totalEvents: stats.totalEvents,
      pendingCount: stats.pendingCount,
      currentHash: stats.currentHash,
    };
  });
  return { appState, activeTabId: source?.getActiveTab()?.id ?? null, tabs };
}

declare global {
  interface Window {
    /** E2E 専用 (dev ビルドのみ)。本番ビルドでは undefined (production-build.spec が見張る) */
    __tcTestSnapshot?: () => TestSnapshot;
    /** E2E 専用 (dev ビルドのみ)。現在の選択位置に単一の executeEdits を適用する */
    __tcTestInsertBlock?: (text: string) => void;
  }
}
