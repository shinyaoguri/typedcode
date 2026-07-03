/**
 * evaluateAnalysis (W5) の不変条件テスト。
 *
 * 純粋関数の混同行列・スイープ・偽陽性圧の計算を、合成した AnalysisReport で検証する
 * (実 proof は不要 — レポートだけで完結する設計)。
 */

import { describe, expect, it } from 'vitest';
import { evaluateAnalysis, formatEvalReportMarkdown } from '../analysis/eval.js';
import type { LabeledAnalysis } from '../analysis/eval.js';
import type { AnalysisReport, AnalysisSeverity, AnalysisDimension } from '../analysis/types.js';

/** 1 つの signal を持つ (または持たない) 最小レポートを作る。 */
function report(
  signals: Array<{ dimension: AnalysisDimension; score: number; confidence: number; severity: AnalysisSeverity }>
): AnalysisReport {
  const SEVERITY_WEIGHT: Record<AnalysisSeverity, number> = { info: 0, notice: 0.5, review: 1 };
  const reviewPriority = signals.reduce(
    (max, s) => Math.max(max, SEVERITY_WEIGHT[s.severity] * s.score * s.confidence),
    0
  );
  return {
    analyzerVersions: { test: '1.0.0' },
    signals: signals.map((s) => ({
      analyzerId: 'test',
      dimension: s.dimension,
      score: s.score,
      confidence: s.confidence,
      severity: s.severity,
      evidence: [],
      summary: 'test',
    })),
    reviewPriority,
  };
}

function item(id: string, label: 'genuine' | 'automated', report: AnalysisReport, condition?: string): LabeledAnalysis {
  return condition === undefined ? { id, label, report } : { id, label, condition, report };
}

describe('evaluateAnalysis corpus composition', () => {
  it('counts genuine and automated totals and per-condition buckets', () => {
    const r = evaluateAnalysis([
      item('a', 'genuine', report([]), 'genuine-ime'),
      item('b', 'genuine', report([]), 'genuine-ime'),
      item(
        'c',
        'automated',
        report([{ dimension: 'automation', score: 0.9, confidence: 0.9, severity: 'review' }]),
        'ai-paste'
      ),
    ]);
    expect(r.corpus.total).toBe(3);
    expect(r.corpus.genuine).toBe(2);
    expect(r.corpus.automated).toBe(1);
    expect(r.corpus.byCondition['genuine-ime']).toEqual({ genuine: 2, automated: 0 });
    expect(r.corpus.byCondition['ai-paste']).toEqual({ genuine: 0, automated: 1 });
  });
});

describe('genuineSignalRate (headline false-positive pressure)', () => {
  it('is zero when no genuine proof emits any signal', () => {
    const r = evaluateAnalysis([
      item('a', 'genuine', report([])),
      item('b', 'automated', report([{ dimension: 'automation', score: 0.9, confidence: 0.9, severity: 'review' }])),
    ]);
    expect(r.genuineSignalRate.anySignal).toBe(0);
    expect(r.genuineSignalRate.notice).toBe(0);
    expect(r.genuineSignalRate.review).toBe(0);
  });

  it('measures the fraction of genuine proofs reaching each severity', () => {
    // 4 genuine: 1 review, 1 notice, 1 info-only, 1 clean.
    const r = evaluateAnalysis([
      item(
        'g1',
        'genuine',
        report([{ dimension: 'transcription-topology', score: 0.4, confidence: 0.3, severity: 'review' }])
      ),
      item(
        'g2',
        'genuine',
        report([{ dimension: 'focus-burst-correlation', score: 0.4, confidence: 0.4, severity: 'notice' }])
      ),
      item('g3', 'genuine', report([{ dimension: 'automation', score: 0.5, confidence: 0.6, severity: 'info' }])),
      item('g4', 'genuine', report([])),
    ]);
    expect(r.genuineSignalRate.review).toBeCloseTo(0.25);
    expect(r.genuineSignalRate.notice).toBeCloseTo(0.5); // review(1) も notice 以上に含む
    expect(r.genuineSignalRate.anySignal).toBeCloseTo(0.75); // info も含む
  });
});

describe('confusion matrix and sweep', () => {
  it('separates cleanly when automated scores high and genuine emits nothing', () => {
    const items: LabeledAnalysis[] = [
      item('g1', 'genuine', report([])),
      item('g2', 'genuine', report([])),
      item(
        'a1',
        'automated',
        report([{ dimension: 'transcription-topology', score: 0.8, confidence: 1, severity: 'notice' }])
      ),
      item(
        'a2',
        'automated',
        report([{ dimension: 'transcription-topology', score: 0.8, confidence: 1, severity: 'notice' }])
      ),
    ];
    const r = evaluateAnalysis(items);
    const dim = r.axes.find((a) => a.axis === 'transcription-topology')!;
    // 閾値 0.5 では automated 2 件を捕え、genuine は score=0 なので絶対に陽性化しない。
    const p = dim.sweep.find((s) => s.threshold === 0.5)!;
    expect(p.tp).toBe(2);
    expect(p.fp).toBe(0);
    expect(p.tn).toBe(2);
    expect(p.fn).toBe(0);
    expect(p.precision).toBe(1);
    expect(p.recall).toBe(1);
    expect(p.fpr).toBe(0);
    // 完全分離なので F1=1 が達成できる。
    expect(dim.bestF1.f1).toBeCloseTo(1);
  });

  it('a genuine proof emitting a signal becomes a false positive at low thresholds', () => {
    const items: LabeledAnalysis[] = [
      item(
        'g1',
        'genuine',
        report([{ dimension: 'focus-burst-correlation', score: 0.3, confidence: 0.45, severity: 'notice' }])
      ),
      item(
        'a1',
        'automated',
        report([{ dimension: 'focus-burst-correlation', score: 0.6, confidence: 0.45, severity: 'notice' }])
      ),
    ];
    const r = evaluateAnalysis(items, { maxFpr: 0 });
    const dim = r.axes.find((a) => a.axis === 'focus-burst-correlation')!;
    // 閾値 0.3: genuine(0.3) も automated(0.6) も陽性 → fp=1。
    const low = dim.sweep.find((s) => s.threshold === 0.3)!;
    expect(low.tp).toBe(1);
    expect(low.fp).toBe(1);
    expect(low.fpr).toBe(1);
    // maxFpr=0 の推奨は genuine を巻き込まない閾値: 0.35 以上で fp=0 になる。
    expect(r.maxFpr).toBe(0);
    expect(dim.recommended.fpr).toBe(0);
    expect(dim.recommended.threshold).toBeGreaterThan(0.3);
  });

  it('never predicts positive for a proof with no signal in the axis (score 0)', () => {
    const items: LabeledAnalysis[] = [
      item('g1', 'genuine', report([])),
      item('a1', 'automated', report([])), // automated だが手掛かりゼロ = 取りこぼし (fn)
    ];
    const r = evaluateAnalysis(items);
    const overall = r.axes.find((a) => a.axis === 'overall')!;
    for (const p of overall.sweep) {
      expect(p.fp).toBe(0); // genuine は score0 で陽性化しない
      expect(p.tp).toBe(0); // automated も score0 で捕まらない
      expect(p.fn).toBe(1); // automated は全閾値で取りこぼし
    }
  });
});

describe('recommended threshold respects the FPR ceiling', () => {
  it('picks the highest-recall point whose fpr <= maxFpr', () => {
    // genuine が中程度 score を出すケースで、FPR 上限 0.5 を満たす最良点を選ぶ。
    const items: LabeledAnalysis[] = [
      item('g1', 'genuine', report([{ dimension: 'automation', score: 0.2, confidence: 1, severity: 'notice' }])),
      item('g2', 'genuine', report([])),
      item('a1', 'automated', report([{ dimension: 'automation', score: 0.4, confidence: 1, severity: 'review' }])),
      item('a2', 'automated', report([{ dimension: 'automation', score: 0.9, confidence: 1, severity: 'review' }])),
    ];
    const r = evaluateAnalysis(items, { maxFpr: 0 });
    const dim = r.axes.find((a) => a.axis === 'automation')!;
    // maxFpr=0: genuine(0.2) を避けるため閾値 > 0.2 が必要。閾値 0.25..0.4 で automated 2件中 a1(0.4)+a2(0.9) を捕える。
    expect(dim.recommended.fpr).toBe(0);
    expect(dim.recommended.recall).toBeCloseTo(1); // 0.4 以下の閾値なら automated 両方を捕えられる
    expect(dim.recommended.fp).toBe(0);
  });
});

describe('formatEvalReportMarkdown', () => {
  it('renders headline genuine signal rate and per-axis sections', () => {
    const r = evaluateAnalysis([
      item('g1', 'genuine', report([])),
      item('a1', 'automated', report([{ dimension: 'automation', score: 0.9, confidence: 0.9, severity: 'review' }])),
    ]);
    const md = formatEvalReportMarkdown(r);
    expect(md).toContain('genuine コーパスの偽陽性圧');
    expect(md).toContain('### overall');
    expect(md).toContain('### automation');
    expect(md).toContain('推奨閾値');
  });
});
