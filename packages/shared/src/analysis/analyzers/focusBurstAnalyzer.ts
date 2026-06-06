/**
 * focus-burst-correlation 分析器 (ADR-0009)。
 *
 * [第一次ヒューリスティック] 長い離脱 → 復帰直後の大量入力を見る。
 *
 * 「離席して (ChatGPT 等を見て) 戻り、まとめて打ち込む」形を狙う。focusChange の blur→focus 対で
 * 離脱が長く、復帰後の一定窓に挿入文字数が多い場合に手掛かりを出す。「考えて戻って一気に書く」
 * 正規ケースも該当し得るため confidence は中程度。本格版は visibility/idle との突合や打鍵動態との
 * 相関まで見る (後続)。
 *
 * 出力は advisory のみ — 判定はしない。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer } from '../types.js';
import type { FocusChangeData } from '../../types/events.js';

const ID = 'focus-burst';
/** これ以上の離脱を「長い離脱」とみなす (ms)。 */
const MIN_BLUR_MS = 15_000;
/** 復帰後この窓の挿入量を見る (ms)。 */
const BURST_WINDOW_MS = 20_000;
/** 復帰後の窓でこれ以上の挿入文字数なら手掛かりとする。 */
const BURST_CHARS = 200;

export const focusBurstAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const events = input.proof.proof.events;
    const signals: AnalysisSignal[] = [];

    let blurAt: number | null = null;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.type !== 'focusChange') continue;

      const focused = (e.data as FocusChangeData | null)?.focused === true;
      if (!focused) {
        blurAt = e.timestamp;
        continue;
      }
      if (blurAt === null) continue;

      const blurMs = e.timestamp - blurAt;
      blurAt = null;
      if (blurMs < MIN_BLUR_MS) continue;

      // 復帰直後の窓に挿入された文字数を集計
      const windowEnd = e.timestamp + BURST_WINDOW_MS;
      let burst = 0;
      for (let j = i + 1; j < events.length; j++) {
        const f = events[j]!;
        if (f.timestamp > windowEnd) break;
        if (f.type === 'contentChange') burst += f.insertLength ?? 0;
      }
      if (burst < BURST_CHARS) continue;

      const awaySec = Math.round(blurMs / 1000);
      signals.push({
        analyzerId: ID,
        dimension: 'focus-burst-correlation',
        score: Math.min(1, burst / (BURST_CHARS * 4)),
        confidence: 0.45,
        severity: 'notice',
        evidence: [{ fromEventIndex: i, note: `~${awaySec}s away, then ${burst} chars` }],
        summary: `Large input burst (${burst} chars) immediately after a ~${awaySec}s absence`,
      });
    }

    return signals;
  },
};
