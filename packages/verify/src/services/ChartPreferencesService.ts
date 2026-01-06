/**
 * チャート設定の永続化サービス
 */

import type { ChartEventVisibility } from '../types/chartVisibility.js';
import { DEFAULT_CHART_EVENT_VISIBILITY } from '../types/chartVisibility.js';

// ============================================================================
// 型定義
// ============================================================================

/** チャート設定 */
export interface ChartPreferences {
  eventVisibility: ChartEventVisibility;
  version: number;
}

// ============================================================================
// 定数
// ============================================================================

const STORAGE_KEY = 'typedcode-verify-chart-preferences';
const CURRENT_VERSION = 1;

// ============================================================================
// ChartPreferencesService
// ============================================================================

/**
 * チャート設定の永続化サービス
 * localStorage を使用して設定を保存・読み込み
 */
export class ChartPreferencesService {
  /**
   * 設定を読み込む
   */
  static load(): ChartPreferences {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as ChartPreferences;
        // バージョンチェック
        if (parsed.version === CURRENT_VERSION) {
          // 既存の設定をデフォルトとマージ（新しいカテゴリ/イベントに対応）
          return {
            version: CURRENT_VERSION,
            eventVisibility: {
              categories: {
                ...DEFAULT_CHART_EVENT_VISIBILITY.categories,
                ...parsed.eventVisibility.categories,
              },
              events: {
                ...DEFAULT_CHART_EVENT_VISIBILITY.events,
                ...parsed.eventVisibility.events,
              },
            },
          };
        }
      }
    } catch (e) {
      console.warn('[ChartPreferencesService] Failed to load preferences:', e);
    }

    // デフォルト設定を返す
    return {
      version: CURRENT_VERSION,
      eventVisibility: { ...DEFAULT_CHART_EVENT_VISIBILITY },
    };
  }

  /**
   * 設定を保存する
   */
  static save(preferences: ChartPreferences): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch (e) {
      console.warn('[ChartPreferencesService] Failed to save preferences:', e);
    }
  }

  /**
   * 可視性設定のみを保存する（便利メソッド）
   */
  static saveVisibility(visibility: ChartEventVisibility): void {
    this.save({
      version: CURRENT_VERSION,
      eventVisibility: visibility,
    });
  }

  /**
   * 設定をリセットする
   */
  static reset(): ChartPreferences {
    const defaults: ChartPreferences = {
      version: CURRENT_VERSION,
      eventVisibility: { ...DEFAULT_CHART_EVENT_VISIBILITY },
    };
    this.save(defaults);
    return defaults;
  }

  /**
   * 設定をクリアする（localStorage から削除）
   */
  static clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('[ChartPreferencesService] Failed to clear preferences:', e);
    }
  }
}
