/**
 * buildAnalysisBundle (Tier A, ADR-0024) の不変条件テスト。
 *
 * バンドルは content-free な派生ビューであること = events / content / fingerprint を
 * 含まないこと、schema が固定されること、入力をそのまま束ねることを検証する。
 */

import { describe, expect, it } from 'vitest';
import { buildAnalysisBundle, ANALYSIS_BUNDLE_SCHEMA } from '../analysis/bundle.js';
import type { ProcessSummary } from '../processSummary.js';
import type { AssuranceResult } from '../assurance.js';
import type { AnalysisReport } from '../analysis/types.js';

const processSummary: ProcessSummary = {
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
  reflectionNotes: ['セミコロン忘れに気づいた'],
  moments: [],
};

const analysis: AnalysisReport = {
  analyzerVersions: { automation: '0.1.0' },
  signals: [],
  reviewPriority: 0,
};

const assurance: AssuranceResult = {
  integrity: 'proven',
  temporal: 'unanchored',
  provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
};

describe('buildAnalysisBundle (Tier A)', () => {
  it('tags the bundle with the fixed schema', () => {
    const bundle = buildAnalysisBundle({ integrityValid: true, processSummary, analysis, assurance });
    expect(bundle.schema).toBe(ANALYSIS_BUNDLE_SCHEMA);
    expect(bundle.schema).toBe('analysis-bundle/1');
  });

  it('carries only the content-free derived views — no events/content/fingerprint', () => {
    const bundle = buildAnalysisBundle({ integrityValid: false, processSummary, analysis, assurance });
    const keys = Object.keys(bundle).sort();
    expect(keys).toEqual(['analysis', 'assurance', 'integrityValid', 'processSummary', 'schema']);
    // 生データの鍵が紛れていないこと (取り違え防止)。
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('"events"');
    expect(json).not.toContain('"fingerprint"');
    expect(json).not.toContain('"typingProofHash"');
  });

  it('passes the derived views through unchanged', () => {
    const bundle = buildAnalysisBundle({ integrityValid: true, processSummary, analysis, assurance });
    expect(bundle.integrityValid).toBe(true);
    expect(bundle.processSummary).toBe(processSummary);
    expect(bundle.analysis).toBe(analysis);
    expect(bundle.assurance).toBe(assurance);
  });
});
