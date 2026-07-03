import { describe, it, expect } from 'vitest';
import { runAnalysis } from '../analysis/orchestrator.js';
import { pureTypingAnalyzer } from '../analysis/analyzers/pureTypingAnalyzer.js';
import type { AnalysisInput, AnalysisSignal, Analyzer } from '../analysis/types.js';

/** 分析器が触る最小フィールドだけを持つ AnalysisInput を組む (残りは未使用)。 */
function makeInput(opts: {
  isPureTyping?: boolean;
  timestamps?: number[];
  /** paste/drop など禁止 InputType のイベントを混ぜる (pureTypingAnalyzer の証拠源)。 */
  prohibitedInputs?: import('../types/events.js').InputType[];
}): AnalysisInput {
  const events: Array<{ sequence: number; timestamp: number; inputType?: string }> = (opts.timestamps ?? []).map(
    (t, i) => ({ sequence: i, timestamp: t })
  );
  (opts.prohibitedInputs ?? []).forEach((inputType, k) => {
    events.push({ sequence: events.length, timestamp: 1000 + k, inputType });
  });
  return {
    proof: { proof: { events } } as unknown as AnalysisInput['proof'],
    verification: {
      valid: true,
      metadataValid: true,
      chainValid: true,
      isPureTyping: opts.isPureTyping ?? true,
    } as AnalysisInput['verification'],
  };
}

function fixedAnalyzer(id: string, signals: AnalysisSignal[]): Analyzer {
  return { id, version: '1.0.0', analyze: () => signals };
}

function signal(partial: Partial<AnalysisSignal> & { analyzerId: string }): AnalysisSignal {
  return {
    dimension: 'automation',
    score: 1,
    confidence: 1,
    severity: 'review',
    evidence: [],
    summary: 'test',
    ...partial,
  };
}

describe('runAnalysis orchestrator', () => {
  it('aggregates signals from every analyzer', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a' })]),
      fixedAnalyzer('b', [signal({ analyzerId: 'b' })]),
    ]);
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['a', 'b']);
  });

  it('records each analyzer id to its version for provenance', async () => {
    const report = await runAnalysis(makeInput({}), [fixedAnalyzer('a', []), fixedAnalyzer('b', [])]);
    expect(report.analyzerVersions).toEqual({ a: '1.0.0', b: '1.0.0' });
  });

  it('sets reviewPriority to the max severity-weighted contribution', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a', severity: 'review', score: 1, confidence: 1 })]),
    ]);
    expect(report.reviewPriority).toBe(1);
  });

  it('does not let info signals raise reviewPriority', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a', severity: 'info', score: 1, confidence: 1 })]),
    ]);
    expect(report.reviewPriority).toBe(0);
  });

  it('keeps other analyzers when one throws', async () => {
    const throwing: Analyzer = {
      id: 'boom',
      version: '1.0.0',
      analyze: () => {
        throw new Error('analyzer failure');
      },
    };
    const report = await runAnalysis(makeInput({}), [throwing, fixedAnalyzer('ok', [signal({ analyzerId: 'ok' })])]);
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['ok']);
    expect(report.analyzerVersions['boom']).toBe('1.0.0');
  });
});

describe('pureTypingAnalyzer (placeholder)', () => {
  it('emits a notice with evidence when non-pure typing has prohibited inputs', async () => {
    const report = await runAnalysis(
      makeInput({ isPureTyping: false, prohibitedInputs: ['insertFromPaste', 'insertFromDrop'] }),
      [pureTypingAnalyzer]
    );
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]!.evidence.length).toBe(2); // paste + drop の event index
    expect(report.signals[0]!.summaryParams).toMatchObject({ paste: 1, drop: 1 });
    expect(report.signals[0]?.severity).toBe('notice');
    expect(report.signals[0]?.dimension).toBe('transcription-topology');
  });

  it('stays silent when typing is pure', async () => {
    const report = await runAnalysis(makeInput({ isPureTyping: true }), [pureTypingAnalyzer]);
    expect(report.signals).toHaveLength(0);
  });

  it('flags a divergent contentSnapshot as bulk evidence (#175)', async () => {
    // 挿入イベント無しで replay 文書を丸ごと差し替える持ち込み口。bulk として数え、
    // evidence の note で snapshot 由来だと分かるようにする。
    const input = {
      proof: {
        proof: {
          events: [{ sequence: 0, timestamp: 0, type: 'contentSnapshot', data: 'int ai() {\n  return 42;\n}\n' }],
        },
      },
      verification: {
        valid: true,
        metadataValid: true,
        chainValid: true,
        isPureTyping: false,
      },
    } as unknown as AnalysisInput;
    const report = await runAnalysis(input, [pureTypingAnalyzer]);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]!.summaryParams).toMatchObject({ paste: 0, drop: 0, bulk: 1 });
    expect(report.signals[0]!.evidence[0]?.note).toBe('divergent-content-snapshot');
  });
});
