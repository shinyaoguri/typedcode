/**
 * computeCohortBaseline / positionInCohort (ADR-0025) の不変条件テスト。
 *
 * 頑健統計・base rate・小N ガード・個票非保持・advisory な位置づけを、合成した
 * AnalysisBundle 列で検証する (実 proof は不要)。
 */

import { describe, expect, it } from 'vitest';
import {
  computeCohortBaseline,
  positionInCohort,
  COHORT_MIN_N,
} from '../analysis/cohort.js';
import type { AnalysisBundle } from '../analysis/bundle.js';
import type { ProcessSummary } from '../processSummary.js';
import type { AnalysisReport, AnalysisDimension, AnalysisSeverity } from '../analysis/types.js';

function summary(over: Partial<ProcessSummary>): ProcessSummary {
  return {
    totalEvents: 100,
    durationMs: 600000,
    contentChangeCount: 100,
    insertedChars: 100,
    deletedChars: 5,
    deletionRatio: 0.05,
    executionCount: 1,
    hasRunResults: true,
    runSuccessCount: 1,
    runFailureCount: 0,
    pauseCount: 2,
    longestPauseMs: 12000,
    focusLossCount: 0,
    externalInputCount: 0,
    reflectionNotes: [],
    moments: [],
    ...over,
  };
}

function report(
  reviewPriority: number,
  signals: Array<{ dimension: AnalysisDimension; severity: AnalysisSeverity }> = []
): AnalysisReport {
  return {
    analyzerVersions: { test: '1.0.0' },
    reviewPriority,
    signals: signals.map((s) => ({
      analyzerId: 'test',
      dimension: s.dimension,
      score: 0.5,
      confidence: 0.5,
      severity: s.severity,
      evidence: [],
      summary: 'test',
    })),
  };
}

function bundle(
  processSummary: ProcessSummary,
  analysis: AnalysisReport,
  integrityValid = true
): AnalysisBundle {
  return {
    schema: 'analysis-bundle/1',
    integrityValid,
    processSummary,
    analysis,
    assurance: {
      integrity: 'proven',
      temporal: 'unanchored',
      provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
    },
  };
}

describe('computeCohortBaseline', () => {
  it('computes robust five-number distributions per metric', () => {
    // durationMs = 100..900 (9 件) → median 500, q1 300, q3 700。
    const bundles = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((d) =>
      bundle(summary({ durationMs: d * 1000 }), report(0))
    );
    const base = computeCohortBaseline(bundles);
    expect(base.cohortSize).toBe(9);
    const dur = base.metrics.durationMs!;
    expect(dur.n).toBe(9);
    expect(dur.median).toBe(500000);
    expect(dur.q1).toBe(300000);
    expect(dur.q3).toBe(700000);
    expect(dur.iqr).toBe(400000);
    expect(dur.min).toBe(100000);
    expect(dur.max).toBe(900000);
  });

  it('flags small cohorts as not sufficient', () => {
    const small = computeCohortBaseline([bundle(summary({}), report(0))]);
    expect(small.cohortSize).toBe(1);
    expect(small.sufficient).toBe(false);

    const enough = computeCohortBaseline(
      Array.from({ length: COHORT_MIN_N }, () => bundle(summary({}), report(0)))
    );
    expect(enough.sufficient).toBe(true);
  });

  it('omits a metric whose values are all null (e.g. deletionRatio with no insertions)', () => {
    const bundles = [
      bundle(summary({ deletionRatio: null }), report(0)),
      bundle(summary({ deletionRatio: null }), report(0)),
    ];
    const base = computeCohortBaseline(bundles);
    expect(base.metrics.deletionRatio).toBeUndefined();
    // 他のメトリクスは出る。
    expect(base.metrics.durationMs).toBeDefined();
  });

  it('computes per-dimension base rate from notable signals only (info excluded)', () => {
    const bundles = [
      bundle(summary({}), report(0.5, [{ dimension: 'automation', severity: 'review' }])),
      bundle(summary({}), report(0.5, [{ dimension: 'automation', severity: 'notice' }])),
      bundle(summary({}), report(0, [{ dimension: 'automation', severity: 'info' }])), // info は数えない
      bundle(summary({}), report(0)),
    ];
    const base = computeCohortBaseline(bundles);
    expect(base.dimensionSignalRate['automation']).toBeCloseTo(0.5); // 4 件中 2 件が notable
  });

  it('retains no per-submission rows (only aggregates)', () => {
    const base = computeCohortBaseline([
      bundle(summary({ reflectionNotes: ['secret note'] }), report(0)),
    ]);
    const json = JSON.stringify(base);
    expect(json).not.toContain('secret note');
    expect(json).not.toContain('reflectionNotes');
    expect(json).not.toContain('processSummary');
  });
});

describe('positionInCohort', () => {
  const cohort = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((d) =>
    bundle(summary({ durationMs: d * 1000 }), report(0))
  );
  const base = computeCohortBaseline(cohort);

  it('places a median submission near the 50th percentile and inside the box', () => {
    const pos = positionInCohort(bundle(summary({ durationMs: 500000 }), report(0)), base);
    const dur = pos.metrics.durationMs!;
    expect(dur.value).toBe(500000);
    expect(dur.percentile).toBeCloseTo(50);
    expect(dur.iqrPosition).toBe(0); // q1..q3 の内側
  });

  it('reports a high outlier as above the box in IQR units', () => {
    const pos = positionInCohort(bundle(summary({ durationMs: 1500000 }), report(0)), base);
    const dur = pos.metrics.durationMs!;
    // q3=700k, iqr=400k → (1500k-700k)/400k = 2.0
    expect(dur.iqrPosition).toBeCloseTo(2);
    expect(dur.percentile).toBe(100);
  });

  it('returns null iqrPosition when the cohort metric has zero IQR', () => {
    const flat = computeCohortBaseline(
      Array.from({ length: 6 }, () => bundle(summary({ focusLossCount: 0 }), report(0)))
    );
    const pos = positionInCohort(bundle(summary({ focusLossCount: 3 }), report(0)), flat);
    expect(pos.metrics.focusLossCount!.iqrPosition).toBeNull();
  });

  it('carries the cohort sufficiency through for UI warnings', () => {
    const small = computeCohortBaseline([bundle(summary({}), report(0))]);
    const pos = positionInCohort(bundle(summary({}), report(0)), small);
    expect(pos.sufficient).toBe(false);
    expect(pos.cohortSize).toBe(1);
  });

  it('marks whether a submission fired a dimension relative to the cohort base rate', () => {
    const withSignal = bundle(summary({}), report(0.5, [{ dimension: 'automation', severity: 'review' }]));
    const pos = positionInCohort(withSignal, base);
    expect(pos.dimensions['automation']).toBeDefined();
    expect(pos.dimensions['automation']!.fired).toBe(true);
    expect(pos.dimensions['automation']!.baseRate).toBe(0); // base コホートは automation を出していない
  });
});
