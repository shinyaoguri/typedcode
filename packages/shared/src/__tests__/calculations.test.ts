/**
 * calculations.ts (検証結果・統計の純関数) のテスト
 */

import { describe, it, expect } from 'vitest';
import {
  formatTypingTime,
  calculateTypingSpeed,
  countPasteEvents,
  countDropEvents,
  calculateChartStats,
} from '../calculations.js';
import type { StoredEvent } from '../types.js';

/** テストに必要な最小限のフィールドだけを持つイベントを作る */
function ev(partial: Record<string, unknown>): StoredEvent {
  return { timestamp: 0, data: null, ...partial } as unknown as StoredEvent;
}

describe('formatTypingTime', () => {
  it('returns a dash when there are fewer than two events', () => {
    expect(formatTypingTime(undefined)).toBe('-');
    expect(formatTypingTime([ev({ timestamp: 0 })])).toBe('-');
  });

  it('formats a span under one minute as seconds only', () => {
    expect(formatTypingTime([ev({ timestamp: 1000 }), ev({ timestamp: 46_000 })])).toBe('45s');
  });

  it('formats a span of a minute or more as minutes and seconds', () => {
    expect(formatTypingTime([ev({ timestamp: 0 }), ev({ timestamp: 330_000 })])).toBe('5m 30s');
  });
});

describe('calculateTypingSpeed', () => {
  it('returns a dash when there are fewer than two events or the span is not positive', () => {
    expect(calculateTypingSpeed(100, undefined)).toBe('-');
    expect(calculateTypingSpeed(100, [ev({ timestamp: 5 })])).toBe('-');
    expect(calculateTypingSpeed(100, [ev({ timestamp: 5 }), ev({ timestamp: 5 })])).toBe('-');
  });

  it('computes characters per minute from the first to the last event', () => {
    // 120 文字を 2 分 = 60 CPM
    expect(calculateTypingSpeed(120, [ev({ timestamp: 0 }), ev({ timestamp: 120_000 })])).toBe('60 CPM');
  });
});

describe('countPasteEvents / countDropEvents', () => {
  const events = [
    ev({ type: 'contentChange', inputType: 'insertFromPaste' }),
    ev({ type: 'externalInput', inputType: 'insertFromPaste' }),
    ev({ type: 'contentChange', inputType: 'insertFromDrop' }),
    ev({ type: 'contentChange', inputType: 'insertText' }),
    ev({ type: 'keyDown', inputType: 'insertFromPaste' }),
  ];

  it('counts only contentChange / externalInput events with the paste input type', () => {
    expect(countPasteEvents(events)).toBe(2);
  });

  it('counts only contentChange / externalInput events with the drop input type', () => {
    expect(countDropEvents(events)).toBe(1);
  });

  it('returns 0 when no events are given', () => {
    expect(countPasteEvents(undefined)).toBe(0);
    expect(countDropEvents(undefined)).toBe(0);
  });
});

describe('calculateChartStats', () => {
  it('averages the recorded dwell and flight times and counts keydown and mouse events', () => {
    const stats = calculateChartStats([
      ev({ type: 'keyDown', data: { flightTime: 100 } }),
      ev({ type: 'keyUp', data: { dwellTime: 40 } }),
      ev({ type: 'keyDown', data: { flightTime: 200 } }),
      ev({ type: 'keyUp', data: { dwellTime: 60 } }),
      ev({ type: 'mousePositionChange' }),
    ]);

    expect(stats).toEqual({ keydownCount: 2, avgDwellTime: 50, avgFlightTime: 150, mouseEventCount: 1 });
  });

  it('ignores times that are missing, negative, non-finite or above the plausible upper bound', () => {
    const stats = calculateChartStats([
      ev({ type: 'keyDown', data: { flightTime: 100 } }),
      ev({ type: 'keyDown', data: { flightTime: -1 } }),
      ev({ type: 'keyDown', data: { flightTime: 10_001 } }),
      ev({ type: 'keyDown', data: { flightTime: Number.NaN } }),
      ev({ type: 'keyDown', data: null }),
      ev({ type: 'keyUp', data: { dwellTime: 10_001 } }),
    ]);

    expect(stats.keydownCount).toBe(5);
    expect(stats.avgFlightTime).toBe(100);
    expect(stats.avgDwellTime).toBe(0);
  });

  it('returns zeros for an empty event list', () => {
    expect(calculateChartStats([])).toEqual({
      keydownCount: 0,
      avgDwellTime: 0,
      avgFlightTime: 0,
      mouseEventCount: 0,
    });
  });
});
