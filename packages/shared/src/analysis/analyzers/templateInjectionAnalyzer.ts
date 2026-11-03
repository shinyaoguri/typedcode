/**
 * テンプレート注入量の分析器 (#416)。
 *
 * `templateInjection` は内容の再生で文書を丸ごと置き換える (`verifyContentReplay`) が、
 * `evaluatePureTyping` はこれを数えない。授業モードの `.tcclass` は署名されておらず、自作の
 * starter に完成品を入れても `isPureTyping` は true のままになる。そこで「テンプレートで入った
 * 文字数」と「打った文字数」を並べて見えるようにする。**info 止まりの量の開示であり、判定ではない**:
 * starter を持つ正規の exam / class の proof はすべて templateInjection を持つので、severity を上げると
 * 全員の `reviewPriority` が上がる。量に閾値を置いて notice / review に振り分けることもしない
 * (ADR-0023 Decision 1)。
 *
 * 数え方 (どちらもハッシュ対象のフィールド。shared の不変条件 12):
 * - テンプレートで入った文字数 = `templateInjection` の `data.content.length` の合計。
 *   `data.contentLength` は自己申告で、再生と照合されるのは `content` だけなので使わない
 * - 打った文字数 = `contentChange` の `insertedCharCount` の合計 (`processSummary` と同じ定義)
 */

import type { AnalysisInput, AnalysisSignal, Analyzer, EvidenceRef } from '../types.js';
import { isTemplateInjectionData } from '../../typingProof/replay.js';
import { insertedCharCount } from '../../typingProof/structuralEdit.js';

const ID = 'template-injection';

export const templateInjectionAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const events = input.proof.proof?.events ?? [];

    let templateChars = 0;
    let typedChars = 0;
    const evidence: EvidenceRef[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;
      if (event.type === 'templateInjection') {
        if (!isTemplateInjectionData(event.data)) continue;
        const chars = event.data.content.length;
        templateChars += chars;
        evidence.push({ fromEventIndex: i, note: `template:${chars}` });
      } else if (event.type === 'contentChange') {
        typedChars += insertedCharCount(event);
      }
    }

    if (templateChars === 0) return [];

    return [
      {
        analyzerId: ID,
        dimension: 'transcription-topology',
        // 異常度ではなく量の開示。info は reviewPriority に寄与しない (orchestrator.ts)。
        score: 0,
        // 文字数は検証済みイベントの実測値 (推定ではない)。
        confidence: 1,
        severity: 'info',
        evidence,
        summary: `Template-injected content: ${templateChars} chars from templates, ${typedChars} chars typed`,
        summaryKey: 'analysis.summary.templateInjection',
        summaryParams: { template: templateChars, typed: typedChars },
      },
    ];
  },
};
