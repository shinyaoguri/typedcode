/**
 * [プレースホルダ分析器] 既存の advisory `isPureTyping` を分析 signal に "折り込む" デモ。
 *
 * ADR-0009 の「散在する advisory (`isPureTyping` 等) を framework の signal へ段階移行
 * する」方針の最小例であり、**検証結果 (`FullVerificationResult`) を消費する形**を示す。
 * paste/drop の存在は弱い手掛かりとして `notice` を 1 つ出すだけで、判定はしない。
 *
 * 本物の転写トポロジー分析 (`range`/`rangeOffset` から構築の形を見る) は後続 spec/ADR。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer } from '../types.js';

const ID = 'example-pure-typing';

export const pureTypingAnalyzer: Analyzer = {
  id: ID,
  version: '0.0.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    if (input.verification.isPureTyping) return [];
    return [
      {
        analyzerId: ID,
        dimension: 'transcription-topology',
        score: 0.3, // プレースホルダ: paste/drop の存在は弱い手掛かり
        confidence: 0.5,
        severity: 'notice',
        evidence: [], // 本実装では paste/drop の event index を載せる
        summary: 'Non-pure typing: paste/drop present (placeholder)',
      },
    ];
  },
};
