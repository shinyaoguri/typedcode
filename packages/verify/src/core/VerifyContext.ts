/**
 * VerifyContext - アプリケーション状態コンテナ
 *
 * 検証アプリケーション全体の状態を一元管理するコンテキスト。
 * editor プロジェクトの AppContext パターンに準拠。
 */

import type { VerifyTabManager } from '../state/VerifyTabManager.js';
import type { VerificationQueue } from '../state/VerificationQueue.js';
import type { VerifyFileListController } from '../ui/VerifyFileListController.js';
import type { VerifyStatusBar } from '../ui/StatusBar.js';
import type { IntegratedTimelineCache, MouseTrajectoryCache } from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/** タブごとのチャートキャッシュ */
export interface TabChartCache {
  tabId: string;
  timeline: IntegratedTimelineCache | null;
  mouseTrajectory: MouseTrajectoryCache | null;
}

/** アプリケーション設定 */
export interface VerifyAppConfig {
  /** API URL */
  apiUrl: string;
  /** 最大イベント数 */
  maxEvents: number;
}

/** VerifyContext インターフェース */
export interface VerifyContext {
  // ==========================================================================
  // 状態管理
  // ==========================================================================

  /** タブ管理 */
  tabManager: VerifyTabManager | null;

  /** 検証キュー */
  verificationQueue: VerificationQueue | null;

  // ==========================================================================
  // UIコントローラー
  // ==========================================================================

  /** ファイルリストコントローラー */
  fileListController: VerifyFileListController | null;

  /** ステータスバー */
  statusBar: VerifyStatusBar | null;

  // ==========================================================================
  // チャート状態（タブごと）
  // ==========================================================================

  /** タブごとのチャートキャッシュ */
  chartCaches: Map<string, TabChartCache>;

  // ==========================================================================
  // UI状態
  // ==========================================================================

  /** 現在表示中のタブID */
  currentDisplayedTabId: string | null;

  /** 現在のレンダリングセッションID */
  currentRenderSessionId: string | null;

  // ==========================================================================
  // 設定
  // ==========================================================================

  /** アプリケーション設定 */
  config: VerifyAppConfig;
}

// ============================================================================
// VerifyContext ファクトリー
// ============================================================================

/** デフォルト設定 */
const DEFAULT_CONFIG: VerifyAppConfig = {
  apiUrl: 'https://typedcode-api.shinya-oguri.workers.dev',
  maxEvents: 100000,
};

/**
 * VerifyContext を作成
 */
export function createVerifyContext(config?: Partial<VerifyAppConfig>): VerifyContext {
  return {
    // 状態管理
    tabManager: null,
    verificationQueue: null,

    // UIコントローラー
    fileListController: null,
    statusBar: null,

    // チャート状態
    chartCaches: new Map(),

    // UI状態
    currentDisplayedTabId: null,
    currentRenderSessionId: null,

    // 設定
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

// ============================================================================
// ユーティリティ関数
// ============================================================================

/**
 * タブのチャートキャッシュを取得または作成
 */
export function getOrCreateChartCache(ctx: VerifyContext, tabId: string): TabChartCache {
  let cache = ctx.chartCaches.get(tabId);
  if (!cache) {
    cache = {
      tabId,
      timeline: null,
      mouseTrajectory: null,
    };
    ctx.chartCaches.set(tabId, cache);
  }
  return cache;
}

/**
 * タブのチャートキャッシュを削除
 */
export function deleteChartCache(ctx: VerifyContext, tabId: string): void {
  ctx.chartCaches.delete(tabId);
}

/**
 * 全てのチャートキャッシュをクリア
 */
export function clearAllChartCaches(ctx: VerifyContext): void {
  ctx.chartCaches.clear();
}

/**
 * マルチファイルモードが初期化済みかどうか
 */
export function isMultiFileModeInitialized(ctx: VerifyContext): boolean {
  return ctx.tabManager !== null;
}
