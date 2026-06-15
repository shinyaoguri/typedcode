/**
 * 既存の advisory `isPureTyping` を分析 signal に "折り込む" 分析器。
 *
 * ADR-0009 の「散在する advisory (`isPureTyping` 等) を framework の signal へ段階移行
 * する」方針の実体であり、**検証結果 (`FullVerificationResult`) と proof の両方を消費する形**
 * を示す。paste/drop の存在は弱い手掛かりとして `notice` を 1 つ出すだけで、判定はしない。
 *
 * 本物の転写トポロジー分析 (`range`/`rangeOffset` から構築の形を見る) は後続 spec/ADR。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer, EvidenceRef } from '../types.js';
import { isProhibitedInputType } from '../../typingProof/InputTypeValidator.js';
import { isStructuralEditInsert } from '../../typingProof/structuralEdit.js';

const ID = 'example-pure-typing';

export const pureTypingAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    if (input.verification.isPureTyping) return [];

    // 禁止 InputType (paste/drop/yank 等) の event index を証拠として集める。
    const evidence: EvidenceRef[] = [];
    let pasteCount = 0;
    let dropCount = 0;
    const events = input.proof.proof?.events ?? [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const inputType = event?.inputType;
      // editor 整形由来の構造的編集 (括弧自動閉じ等) は外部入力の証拠に数えない (誤検知回避)。
      if (inputType && isProhibitedInputType(inputType) && !(event && isStructuralEditInsert(event))) {
        if (inputType === 'insertFromDrop') dropCount++;
        else pasteCount++;
        evidence.push({ fromEventIndex: i, note: inputType });
      }
    }

    const total = pasteCount + dropCount;
    if (total === 0) return []; // isPureTyping=false だが禁止入力が見つからない (保守的に黙る)

    return [
      {
        analyzerId: ID,
        dimension: 'transcription-topology',
        score: 0.3, // paste/drop の存在は弱い手掛かり (判定ではない)
        confidence: 0.5,
        severity: 'notice',
        evidence,
        summary: `External input present: ${pasteCount} paste, ${dropCount} drop`,
        summaryKey: 'analysis.summary.externalInput',
        summaryParams: { paste: pasteCount, drop: dropCount },
      },
    ];
  },
};
