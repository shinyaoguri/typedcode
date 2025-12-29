/**
 * ChartState - チャート状態管理
 *
 * タブごとのチャートキャッシュとシークバー状態を管理します。
 * charts.ts と seekbar.ts のグローバル状態を統合。
 */

import type { StoredEvent } from '@typedcode/shared';
import type { IntegratedTimelineCache, MouseTrajectoryCache, ContentCache } from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/** シークバー状態 */
export interface SeekbarState {
  /** 現在のイベント配列 */
  events: StoredEvent[];
  /** 現在のイベントインデックス */
  currentIndex: number;
  /** 再生中かどうか */
  isPlaying: boolean;
  /** 再生インターバル */
  playInterval: ReturnType<typeof setInterval> | null;
  /** 最終コンテンツ */
  finalContent: string;
  /** コンテンツキャッシュ */
  contentCache: ContentCache;
}

/** タブごとのチャート状態 */
export interface TabChartState {
  /** タブID */
  tabId: string;
  /** 統合タイムラインキャッシュ */
  timelineCache: IntegratedTimelineCache | null;
  /** マウス軌跡キャッシュ */
  mouseCache: MouseTrajectoryCache | null;
  /** シークバー状態 */
  seekbar: SeekbarState;
}

// ============================================================================
// ChartStateManager クラス
// ============================================================================

/**
 * チャート状態マネージャー
 *
 * タブごとのチャート状態を管理するシングルトンクラス。
 */
export class ChartStateManager {
  /** タブごとの状態 */
  private states: Map<string, TabChartState> = new Map();
  /** 現在のアクティブタブID */
  private activeTabId: string | null = null;

  /**
   * タブの状態を取得または作成
   */
  getOrCreate(tabId: string): TabChartState {
    let state = this.states.get(tabId);
    if (!state) {
      state = this.createDefaultState(tabId);
      this.states.set(tabId, state);
    }
    return state;
  }

  /**
   * タブの状態を取得
   */
  get(tabId: string): TabChartState | undefined {
    return this.states.get(tabId);
  }

  /**
   * アクティブタブの状態を取得
   */
  getActive(): TabChartState | null {
    if (!this.activeTabId) return null;
    return this.states.get(this.activeTabId) ?? null;
  }

  /**
   * アクティブタブを設定
   */
  setActiveTab(tabId: string): void {
    this.activeTabId = tabId;
  }

  /**
   * アクティブタブIDを取得
   */
  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /**
   * タブの状態を削除
   */
  delete(tabId: string): void {
    const state = this.states.get(tabId);
    if (state) {
      // 再生中なら停止
      if (state.seekbar.playInterval) {
        clearInterval(state.seekbar.playInterval);
      }
      this.states.delete(tabId);
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  /**
   * すべての状態をクリア
   */
  clear(): void {
    // すべての再生を停止
    for (const state of this.states.values()) {
      if (state.seekbar.playInterval) {
        clearInterval(state.seekbar.playInterval);
      }
    }
    this.states.clear();
    this.activeTabId = null;
  }

  /**
   * タイムラインキャッシュを更新
   */
  setTimelineCache(tabId: string, cache: IntegratedTimelineCache): void {
    const state = this.getOrCreate(tabId);
    state.timelineCache = cache;
  }

  /**
   * マウスキャッシュを更新
   */
  setMouseCache(tabId: string, cache: MouseTrajectoryCache): void {
    const state = this.getOrCreate(tabId);
    state.mouseCache = cache;
  }

  /**
   * シークバー状態を初期化
   */
  initializeSeekbar(tabId: string, events: StoredEvent[], finalContent: string): void {
    const state = this.getOrCreate(tabId);

    // 既存の再生を停止
    if (state.seekbar.playInterval) {
      clearInterval(state.seekbar.playInterval);
    }

    state.seekbar = {
      events,
      currentIndex: events.length,
      isPlaying: false,
      playInterval: null,
      finalContent,
      contentCache: new Map(),
    };
  }

  /**
   * シークバーのインデックスを更新
   */
  setSeekbarIndex(tabId: string, index: number): void {
    const state = this.states.get(tabId);
    if (state) {
      state.seekbar.currentIndex = index;
    }
  }

  /**
   * 再生状態を更新
   */
  setPlaying(tabId: string, isPlaying: boolean, interval?: ReturnType<typeof setInterval> | null): void {
    const state = this.states.get(tabId);
    if (state) {
      state.seekbar.isPlaying = isPlaying;
      if (interval !== undefined) {
        state.seekbar.playInterval = interval;
      }
    }
  }

  /**
   * デフォルトの状態を作成
   */
  private createDefaultState(tabId: string): TabChartState {
    return {
      tabId,
      timelineCache: null,
      mouseCache: null,
      seekbar: {
        events: [],
        currentIndex: 0,
        isPlaying: false,
        playInterval: null,
        finalContent: '',
        contentCache: new Map(),
      },
    };
  }

  /**
   * 登録されているタブ数を取得
   */
  get size(): number {
    return this.states.size;
  }

  /**
   * すべてのタブIDを取得
   */
  getTabIds(): string[] {
    return Array.from(this.states.keys());
  }
}

// ============================================================================
// シングルトンインスタンス（後方互換用）
// ============================================================================

/** グローバルなチャート状態マネージャー */
export const chartStateManager = new ChartStateManager();
