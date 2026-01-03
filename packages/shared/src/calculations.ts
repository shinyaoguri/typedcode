/**
 * Calculation utilities for TypedCode
 * Pure calculation functions for verification results and statistics
 * Platform-agnostic (works in browser and Node.js)
 */

import type { StoredEvent } from './types.js';

// ============================================================================
// 型定義
// ============================================================================

/** チャート統計 */
export interface ChartStats {
  keydownCount: number;
  avgDwellTime: number;
  avgFlightTime: number;
  mouseEventCount: number;
}

// ============================================================================
// 時間・速度計算関数
// ============================================================================

/**
 * Format typing time from events
 * @param events - Array of stored events
 * @returns Formatted time string (e.g., "5m 30s" or "45s")
 */
export function formatTypingTime(events?: StoredEvent[]): string {
  if (!events || events.length < 2) return '-';

  const firstTime = events[0]!.timestamp;
  const lastTime = events[events.length - 1]!.timestamp;
  const totalMs = lastTime - firstTime;

  const seconds = Math.floor(totalMs / 1000) % 60;
  const minutes = Math.floor(totalMs / 60000);

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Calculate typing speed in CPM (characters per minute)
 * @param contentLength - Length of the content
 * @param events - Array of stored events
 * @returns Formatted speed string (e.g., "120 CPM")
 */
export function calculateTypingSpeed(contentLength: number, events?: StoredEvent[]): string {
  if (!events || events.length < 2) return '-';

  const firstTime = events[0]!.timestamp;
  const lastTime = events[events.length - 1]!.timestamp;
  const minutes = (lastTime - firstTime) / 60000;

  if (minutes <= 0) return '-';

  const cpm = Math.round(contentLength / minutes);
  return `${cpm} CPM`;
}

// ============================================================================
// イベントカウント関数
// ============================================================================

/**
 * Count paste events in events array
 * @param events - Array of stored events
 * @returns Number of paste events
 */
export function countPasteEvents(events?: StoredEvent[]): number {
  if (!events) return 0;

  return events.filter(
    (e) => (e.type === 'contentChange' || e.type === 'externalInput') && e.inputType === 'insertFromPaste'
  ).length;
}

/**
 * Count drop events in events array
 * @param events - Array of stored events
 * @returns Number of drop events
 */
export function countDropEvents(events?: StoredEvent[]): number {
  if (!events) return 0;

  return events.filter(
    (e) => (e.type === 'contentChange' || e.type === 'externalInput') && e.inputType === 'insertFromDrop'
  ).length;
}

// ============================================================================
// チャート統計関数
// ============================================================================

/**
 * Calculate chart statistics from events
 * @param events - Array of stored events
 * @returns Chart statistics (keydown count, avg dwell/flight times, mouse event count)
 */
export function calculateChartStats(events: StoredEvent[]): ChartStats {
  let keydownCount = 0;
  let mouseEventCount = 0;
  const dwellTimes: number[] = [];
  const flightTimes: number[] = [];
  let lastKeyUpTime = 0;

  for (const event of events) {
    if (event.type === 'keyDown') {
      keydownCount++;
      if (lastKeyUpTime > 0) {
        flightTimes.push(event.timestamp - lastKeyUpTime);
      }
    } else if (event.type === 'keyUp') {
      lastKeyUpTime = event.timestamp;
    } else if (event.type === 'mousePositionChange') {
      mouseEventCount++;
    }
  }

  return {
    keydownCount,
    avgDwellTime: dwellTimes.length > 0 ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length : 0,
    avgFlightTime: flightTimes.length > 0 ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length : 0,
    mouseEventCount,
  };
}
