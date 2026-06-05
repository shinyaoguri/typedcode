/**
 * [プレースホルダ分析器] イベント間の最大時間ギャップを 1 つの `info` signal にする。
 *
 * 目的は **方向性のデモ**: event ストリームを読み、証拠 (event 範囲) 付きで signal を
 * 出す形を示すだけ。判定はしない (`info` なので reviewPriority に寄与しない)。
 *
 * 本物の focus↔バースト相関 (離脱 → 復帰 → 即・高速・低エラーのバースト検出) は
 * 後続 spec/ADR。ここを差し替える形で実装する。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer } from '../types.js';

const ID = 'example-largest-gap';

export const largestGapAnalyzer: Analyzer = {
  id: ID,
  version: '0.0.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const events = input.proof.proof.events;
    if (events.length < 2) return [];

    let maxGapMs = 0;
    let atIndex = -1;
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const cur = events[i]!;
      const gap = cur.timestamp - prev.timestamp;
      if (gap > maxGapMs) {
        maxGapMs = gap;
        atIndex = i;
      }
    }
    if (atIndex < 0) return [];

    const gap = Math.round(maxGapMs);
    return [
      {
        analyzerId: ID,
        dimension: 'focus-burst-correlation',
        score: 0, // プレースホルダ: 異常度は判定しない
        confidence: 0,
        severity: 'info',
        evidence: [{ fromEventIndex: atIndex - 1, toEventIndex: atIndex, note: `gap ${gap}ms` }],
        summary: `Largest inter-event gap: ${gap}ms (placeholder)`,
      },
    ];
  },
};
