/**
 * 統計関連の型定義
 */

import type { EventType, InputType } from './events.js';

/** イベントタイプ別カウント */
export type EventTypeCounts = Partial<Record<EventType, number>>;

/** 入力タイプ別カウント */
export type InputTypeCounts = Partial<Record<InputType, number>>;

/** 統計情報 */
export interface TypingStats {
  totalEvents: number;
  duration: number;
  eventTypes: EventTypeCounts;
  currentHash: string | null;
  pendingCount: number;  // PoSW計算待ちのイベント数
}

/** タイピング統計 */
export interface TypingStatistics {
  totalEvents: number;
  pasteEvents: number;
  internalPasteEvents: number;
  dropEvents: number;
  insertEvents: number;
  deleteEvents: number;
  templateEvents: number;  // テンプレート注入イベント数
  duration: number;
  averageWPM: number;
}

/** ログ統計 */
export interface LogStats {
  total: number;
  byType: EventTypeCounts;
  byInputType: InputTypeCounts;
}
