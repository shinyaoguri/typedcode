/**
 * StatisticsCalculator - 統計計算
 * タイピング統計の計算を担当
 */

import type { StoredEvent, TypingStats, TypingStatistics, EventType } from '../types.js';

export class StatisticsCalculator {
  /**
   * 基本統計情報を取得
   */
  getStats(
    events: StoredEvent[],
    startTime: number,
    currentHash: string | null,
    pendingCount: number
  ): TypingStats {
    const duration = performance.now() - startTime;
    const eventTypes = events.reduce((acc, event) => {
      const eventType = event.type as EventType;
      acc[eventType] = (acc[eventType] ?? 0) + 1;
      return acc;
    }, {} as Record<EventType, number>);

    return {
      totalEvents: events.length,
      duration: duration / 1000,
      eventTypes,
      currentHash,
      pendingCount
    };
  }

  /**
   * タイピング統計を取得
   */
  getTypingStatistics(events: StoredEvent[], startTime: number): TypingStatistics {
    let pasteEvents = 0;
    let dropEvents = 0;
    let insertEvents = 0;
    let deleteEvents = 0;
    let templateEvents = 0;

    for (const event of events) {
      if (event.inputType === 'insertFromPaste') pasteEvents++;
      if (event.inputType === 'insertFromDrop') dropEvents++;
      if (event.type === 'contentChange' && event.data) insertEvents++;
      if (event.inputType?.startsWith('delete')) deleteEvents++;
      if (event.type === 'templateInjection') templateEvents++;
    }

    const duration = performance.now() - startTime;
    const averageWPM = insertEvents / (duration / 60000);

    return {
      totalEvents: events.length,
      pasteEvents,
      dropEvents,
      insertEvents,
      deleteEvents,
      templateEvents,
      duration,
      averageWPM: Math.round(averageWPM * 10) / 10
    };
  }
}
