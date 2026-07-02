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
import { isBenignEditorInsert, isFlaggedBulkInsert, SessionProvenanceLedger } from '../../typingProof/structuralEdit.js';
import { isDivergentContentSnapshot } from '../../typingProof/replay.js';

const ID = 'example-pure-typing';

export const pureTypingAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    if (input.verification.isPureTyping) return [];

    // 外部入力の event index を証拠として集める。
    // - paste/drop 等の禁止 InputType (正規な editor 補完は除く)
    // - AI/スニペットによる複数行の一括投入 (replaceContent/insertText は禁止型でないので明示的に拾う)
    // - replay 文書と乖離した contentSnapshot (#175: 挿入イベント無しの全文差し替え。bulk に含める)
    const evidence: EvidenceRef[] = [];
    let pasteCount = 0;
    let dropCount = 0;
    let bulkCount = 0;
    const events = input.proof.proof?.events ?? [];
    const ledger = new SessionProvenanceLedger();
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;
      const divergentSnapshot = isDivergentContentSnapshot(event, ledger.currentContent);
      const sessionDerived = ledger.checkAndApply(event);
      const inputType = event.inputType;
      if (divergentSnapshot) {
        bulkCount++;
        evidence.push({ fromEventIndex: i, note: 'divergent-content-snapshot' });
      } else if (isFlaggedBulkInsert(event, sessionDerived)) {
        // 複数行のコード一括投入 (Copilot/Cursor が Tab で全体投入する類)。最も注視すべき痕跡。
        bulkCount++;
        evidence.push({ fromEventIndex: i, note: `multiline-bulk:${inputType ?? 'insert'}` });
      } else if (inputType && isProhibitedInputType(inputType) && !isBenignEditorInsert(event)) {
        if (inputType === 'insertFromDrop') dropCount++;
        else pasteCount++;
        evidence.push({ fromEventIndex: i, note: inputType });
      }
    }

    const total = pasteCount + dropCount + bulkCount;
    if (total === 0) return []; // isPureTyping=false だが外部入力が見つからない (保守的に黙る)

    return [
      {
        analyzerId: ID,
        dimension: 'transcription-topology',
        // 複数行の一括投入は強めの手掛かり、単発 paste/drop は弱い手掛かり (いずれも判定ではない)。
        score: bulkCount > 0 ? 0.5 : 0.3,
        confidence: 0.5,
        severity: 'notice',
        evidence,
        summary: `External input present: ${pasteCount} paste, ${dropCount} drop, ${bulkCount} bulk insertion(s)`,
        summaryKey: 'analysis.summary.externalInput',
        summaryParams: { paste: pasteCount, drop: dropCount, bulk: bulkCount },
      },
    ];
  },
};
