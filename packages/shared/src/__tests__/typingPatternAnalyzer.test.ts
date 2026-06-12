/**
 * typingPatternAnalyzer (ADR-0009 への打鍵動態折り込み) の契約テスト。
 *
 * - 打鍵動態サンプルが乏しい proof では黙る (★6b ガード)。
 * - 出す signal は keystroke-content-consistency 次元で、**review に上げない** (W5 ゲート)。
 */

import { describe, expect, it } from 'vitest';
import { typingPatternAnalyzer } from '../analysis/analyzers/typingPatternAnalyzer.js';
import type { AnalysisInput } from '../analysis/types.js';
import type { StoredEvent } from '../types/index.js';

function keyEvent(type: 'keyDown' | 'keyUp', timestamp: number, extra: Record<string, unknown>): StoredEvent {
  return {
    type,
    timestamp,
    data: { key: 'a', code: 'KeyA', modifiers: { shift: false, ctrl: false, alt: false, meta: false }, ...extra },
  } as unknown as StoredEvent;
}

/** n 個の機械的に均一な打鍵 (dwell/flight 一定) を作る。リズムが規則的すぎて所見が出やすい。 */
function mechanicalKeystrokes(n: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    events.push(keyEvent('keyDown', t, { flightTime: 100 }));
    t += 80;
    events.push(keyEvent('keyUp', t, { dwellTime: 80 }));
    t += 20;
  }
  return events;
}

function input(events: StoredEvent[]): AnalysisInput {
  return { proof: { proof: { events } } } as unknown as AnalysisInput;
}

describe('typingPatternAnalyzer', () => {
  it('stays silent with no events', async () => {
    expect(await typingPatternAnalyzer.analyze(input([]))).toEqual([]);
  });

  it('stays silent when keystroke-dynamics samples are too few (accessibility guard)', async () => {
    // dwell サンプル 10 < 30 のガード。totalEvents も少ない。
    const signals = await typingPatternAnalyzer.analyze(input(mechanicalKeystrokes(10)));
    expect(signals).toEqual([]);
  });

  it('emits keystroke-content-consistency signals for mechanically uniform typing, never review', async () => {
    // 60 ペア → dwell 60 >= 30, totalEvents 120 >= minEventsRequired(100)。
    const signals = await typingPatternAnalyzer.analyze(input(mechanicalKeystrokes(60)));
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.dimension).toBe('keystroke-content-consistency');
      expect(s.analyzerId).toBe('typing-pattern');
      // W5 ゲート: heuristic は review に上げない。
      expect(s.severity).not.toBe('review');
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      // ローカライズ用キーが付く (verify が解決)。
      expect(typeof s.summaryKey).toBe('string');
    }
  });
});
