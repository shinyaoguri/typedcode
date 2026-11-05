/**
 * toAggregateBundle (ADR-0024 Tier S、#304) の不変条件テスト。
 *
 * Tier S は数値とカテゴリだけを allowlist で書き出す集計用の派生ビュー。Tier A
 * (`AnalysisBundle`) は参照をそのまま束ねるので、自由記述 (reflectionNotes / signal の
 * summary・summaryParams・evidence.note / 外部 analyzer が決める analyzerId・dimension) や
 * 型に無い余分なフィールドも素通しする。Tier S はそれらを 1 つも出さないことを、
 * 自由記述の全欄に `SECRET-*` を詰めた入力で確かめる。
 */

import { describe, expect, it } from 'vitest';
import { AGGREGATE_BUNDLE_SCHEMA, toAggregateBundle } from '../analysis/aggregateBundle.js';
import { buildAnalysisBundle, DERIVED_VIEW_NOTICE, type AnalysisBundle } from '../analysis/bundle.js';
import { computeCohortBaseline } from '../analysis/cohort.js';
import type { AnalysisDimension, AnalysisReport, AnalysisSeverity } from '../analysis/types.js';
import type { AssuranceResult } from '../assurance.js';
import type { ProcessSummary } from '../processSummary.js';

function summary(over: Partial<ProcessSummary> = {}): ProcessSummary {
  return {
    totalEvents: 120,
    durationMs: 600000,
    contentChangeCount: 100,
    insertedChars: 90,
    deletedChars: 10,
    deletionRatio: 10 / 90,
    executionCount: 2,
    hasRunResults: true,
    runSuccessCount: 1,
    runFailureCount: 1,
    pauseCount: 3,
    longestPauseMs: 18000,
    focusLossCount: 1,
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
    analyzerVersions: { automation: '0.1.0' },
    analyzerStatus: { automation: { version: '0.1.0', status: 'ok' } },
    reviewPriority,
    signals: signals.map((s) => ({
      analyzerId: 'automation',
      dimension: s.dimension,
      score: 0.5,
      confidence: 0.25,
      severity: s.severity,
      evidence: [{ fromEventIndex: 3 }],
      summary: 'summary',
    })),
  };
}

const assurance: AssuranceResult = {
  integrity: 'proven',
  temporal: 'unanchored',
  provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
};

function tierA(processSummary: ProcessSummary, analysis: AnalysisReport, integrityValid = true): AnalysisBundle {
  return buildAnalysisBundle({ integrityValid, processSummary, analysis, assurance });
}

/** 自由記述の全欄と、型に無い余分なフィールドに `SECRET-*` を詰めた Tier A。 */
function leakyBundle(): AnalysisBundle {
  const processSummary = summary({
    reflectionNotes: ['SECRET-NOTE'],
    moments: [{ kind: 'first-run', fromEventIndex: 7, timestamp: 1, value: 1 }],
  });
  Object.assign(processSummary, { leak: 'SECRET-EXTRA-SUMMARY' });
  const analysis: AnalysisReport = {
    analyzerVersions: { 'SECRET-ANALYZER-VERSION-KEY': 'SECRET-VERSION' },
    analyzerStatus: {
      'SECRET-STATUS-KEY': { version: 'SECRET-STATUS-VERSION', status: 'failed', message: 'SECRET-MESSAGE' },
      automation: { version: '0.1.0', status: 'ok' },
    },
    reviewPriority: 0.4,
    signals: [
      {
        analyzerId: 'SECRET-ANALYZER-ID',
        dimension: 'automation',
        score: 0.8,
        confidence: 0.6,
        severity: 'review',
        evidence: [{ fromEventIndex: 11, toEventIndex: 12, note: 'SECRET-EVIDENCE' }],
        summary: 'SECRET-SUMMARY',
        summaryKey: 'SECRET-SUMMARY-KEY',
        summaryParams: { x: 'SECRET-PARAM' },
      },
      {
        analyzerId: 'external',
        // 外部 analyzer は dimension を自由な文字列にできる (orchestrator は検査しない)。
        dimension: 'SECRET-DIMENSION' as AnalysisDimension,
        score: 0.1,
        confidence: 0.1,
        severity: 'SECRET-SEVERITY' as AnalysisSeverity,
        evidence: [],
        summary: 'x',
      },
    ],
  };
  Object.assign(analysis.signals[0]!, { leak: 'SECRET-EXTRA-SIGNAL' });
  Object.assign(analysis, { leak: 'SECRET-EXTRA-ANALYSIS' });
  const leakyAssurance = {
    integrity: 'SECRET-INTEGRITY',
    temporal: 'anchored',
    provenance: { pureTyping: true, notableSignals: 1, reviewPriority: 0.4, leak: 'SECRET-EXTRA-PROVENANCE' },
    leak: 'SECRET-EXTRA-ASSURANCE',
  } as unknown as AssuranceResult;
  const bundle = buildAnalysisBundle({ integrityValid: true, processSummary, analysis, assurance: leakyAssurance });
  Object.assign(bundle, { filename: 'SECRET-FILENAME', fingerprint: { canvas: 'SECRET-FP' }, leak: 'SECRET-EXTRA' });
  return bundle;
}

describe('toAggregateBundle (Tier S, #304)', () => {
  it('emits no free text and no unknown field, even when every free-text slot holds a secret', () => {
    const json = JSON.stringify(toAggregateBundle(leakyBundle()));
    expect(json).not.toContain('SECRET');
  });

  it('serializes exactly the allowlisted keys at every level', () => {
    const agg = toAggregateBundle(leakyBundle());
    expect(Object.keys(agg).sort()).toEqual(
      ['analysis', 'assurance', 'integrityValid', 'notice', 'processSummary', 'schema'].sort()
    );
    expect(Object.keys(agg.processSummary).sort()).toEqual(
      [
        'contentChangeCount',
        'deletedChars',
        'deletionRatio',
        'durationMs',
        'executionCount',
        'externalInputCount',
        'focusLossCount',
        'hasRunResults',
        'insertedChars',
        'longestPauseMs',
        'pauseCount',
        'runFailureCount',
        'runSuccessCount',
        'totalEvents',
      ].sort()
    );
    expect(Object.keys(agg.analysis).sort()).toEqual(['analyzerStatusCounts', 'reviewPriority', 'signals']);
    expect(Object.keys(agg.analysis.signals[0]!).sort()).toEqual(['confidence', 'dimension', 'score', 'severity']);
    expect(Object.keys(agg.assurance).sort()).toEqual(['integrity', 'provenance', 'temporal']);
    expect(Object.keys(agg.assurance.provenance).sort()).toEqual(['notableSignals', 'pureTyping', 'reviewPriority']);
  });

  it('drops event indexes, filenames and raw-data keys', () => {
    const json = JSON.stringify(toAggregateBundle(leakyBundle()));
    for (const key of ['fingerprint', 'events', 'content', 'filename', 'moments', 'fromEventIndex', 'toEventIndex']) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it('copies the allowlisted numbers and categories unchanged', () => {
    const agg = toAggregateBundle(leakyBundle());
    expect(agg.schema).toBe(AGGREGATE_BUNDLE_SCHEMA);
    expect(agg.schema).toBe('aggregate-bundle/1');
    expect(agg.integrityValid).toBe(true);
    expect(agg.processSummary.durationMs).toBe(600000);
    expect(agg.processSummary.deletionRatio).toBeCloseTo(10 / 90);
    expect(agg.processSummary.hasRunResults).toBe(true);
    expect(agg.analysis.reviewPriority).toBe(0.4);
    expect(agg.analysis.signals[0]).toEqual({
      dimension: 'automation',
      severity: 'review',
      score: 0.8,
      confidence: 0.6,
    });
    expect(agg.analysis.analyzerStatusCounts).toEqual({ ok: 1, failed: 1, timeout: 0, 'invalid-output': 0 });
    expect(agg.assurance.temporal).toBe('anchored');
    expect(agg.assurance.provenance).toEqual({ pureTyping: true, notableSignals: 1, reviewPriority: 0.4 });
  });

  it('maps unknown enum values to "other"', () => {
    const agg = toAggregateBundle(leakyBundle());
    expect(agg.analysis.signals[1]!.dimension).toBe('other');
    expect(agg.analysis.signals[1]!.severity).toBe('other');
    expect(agg.assurance.integrity).toBe('other');
  });

  it('turns non-finite or non-number metrics into null and non-true booleans into false', () => {
    const bad = tierA(
      summary({
        durationMs: Number.NaN,
        insertedChars: Number.POSITIVE_INFINITY,
        pauseCount: 'SECRET' as unknown as number,
        hasRunResults: 'yes' as unknown as boolean,
      }),
      report(Number.NaN),
      'true' as unknown as boolean
    );
    const agg = toAggregateBundle(bad);
    expect(agg.processSummary.durationMs).toBeNull();
    expect(agg.processSummary.insertedChars).toBeNull();
    expect(agg.processSummary.pauseCount).toBeNull();
    expect(agg.processSummary.hasRunResults).toBe(false);
    expect(agg.analysis.reviewPriority).toBeNull();
    expect(agg.integrityValid).toBe(false);
  });

  it('tolerates a pre-#301 report without analyzerStatus', () => {
    const old = report(0);
    delete (old as Partial<AnalysisReport>).analyzerStatus;
    const agg = toAggregateBundle(tierA(summary(), old));
    expect(agg.analysis.analyzerStatusCounts).toEqual({ ok: 0, failed: 0, timeout: 0, 'invalid-output': 0 });
  });

  it('gives the same cohort baseline as the Tier A bundles it was derived from', () => {
    const bundles = [
      tierA(
        summary({ durationMs: 100000, deletionRatio: null }),
        report(0.1, [{ dimension: 'automation', severity: 'notice' }])
      ),
      tierA(summary({ durationMs: 200000, longestPauseMs: null }), report(0.2)),
      tierA(
        summary({ durationMs: 300000, pauseCount: 9 }),
        report(0.3, [{ dimension: 'automation', severity: 'info' }])
      ),
      tierA(
        summary({ durationMs: 400000, focusLossCount: 4 }),
        report(0.7, [{ dimension: 'focus-burst-correlation', severity: 'review' }])
      ),
      tierA(summary({ durationMs: 500000 }), report(0.5)),
      tierA(summary({ durationMs: 600000, insertedChars: 3 }), report(0.9), false),
    ];
    expect(computeCohortBaseline(bundles.map(toAggregateBundle))).toEqual(computeCohortBaseline(bundles));
  });

  it('carries the fixed derived-view notice, as the Tier A bundle does', () => {
    const a = tierA(summary(), report(0));
    expect(a.notice).toBe(DERIVED_VIEW_NOTICE);
    expect(toAggregateBundle(a).notice).toBe(DERIVED_VIEW_NOTICE);
    expect(DERIVED_VIEW_NOTICE).toContain('not independently verifiable');
  });
});
