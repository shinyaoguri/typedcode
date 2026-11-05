/**
 * Tier S 集計バンドル (ADR-0024 のデータ最小化ティア、#304)。
 *
 * Tier A (`AnalysisBundle`) から、**数値とカテゴリだけ**を allowlist で 1 項目ずつ書き出した
 * 集計・研究用の派生ビュー。コホート基準 (ADR-0025、`computeCohortBaseline`) の入力になる。
 *
 * 不変条件 (ADR-0024 Amendment):
 * - **allowlist で serialize する。** spread・`Object.assign`・丸ごとのコピーで作らない。
 *   Tier A は参照をそのまま束ねるので、型を narrow しただけでは実行時の余分なフィールドが残る。
 * - **自由記述を出さない**: `reflectionNotes`、signal の `summary` / `summaryKey` / `summaryParams` /
 *   `evidence` (event index と note)、`analyzerId`、`analyzerVersions` / `analyzerStatus` の id と
 *   message、`moments` (event index)。ファイル名も持たない (CLI が足す `filename` は Tier A だけ)。
 * - **列挙値は既知集合で照合し、外れたら `'other'`**: 外部 analyzer は `dimension` を任意の
 *   文字列にできる (orchestrator は検査しない)。数値は有限数でなければ `null`、真偽値は `true`
 *   以外を `false` にする — どの欄にも文字列が入りこまない。
 * - 単独では整合性検証できない (`DERIVED_VIEW_NOTICE` を必ず載せる)。
 */

import type { AnalyzerRunStatus, AnalysisDimension, AnalysisSeverity } from './types.js';
import type { IntegrityLevel, TemporalLevel } from '../assurance.js';
import { DERIVED_VIEW_NOTICE, type AnalysisBundle } from './bundle.js';

/** Tier S バンドルの schema 識別子。 */
export const AGGREGATE_BUNDLE_SCHEMA = 'aggregate-bundle/1' as const;

/** 既知集合の外の列挙値。 */
export type AggregateOther = 'other';

/** Tier S の過程要約。`ProcessSummary` の数値と `hasRunResults` だけ (自由記述と event index なし)。 */
export interface AggregateProcessSummary {
  totalEvents: number | null;
  durationMs: number | null;
  contentChangeCount: number | null;
  insertedChars: number | null;
  deletedChars: number | null;
  deletionRatio: number | null;
  executionCount: number | null;
  hasRunResults: boolean;
  runSuccessCount: number | null;
  runFailureCount: number | null;
  pauseCount: number | null;
  longestPauseMs: number | null;
  focusLossCount: number | null;
  externalInputCount: number | null;
}

/** Tier S の signal。次元・重大度・数値だけ (`analyzerId` / `summary` / `evidence` なし)。 */
export interface AggregateSignal {
  dimension: AnalysisDimension | AggregateOther;
  severity: AnalysisSeverity | AggregateOther;
  score: number | null;
  confidence: number | null;
}

/** Tier S の分析。分析器の id と message は出さず、状態ごとの件数だけを持つ。 */
export interface AggregateAnalysis {
  reviewPriority: number | null;
  /** 分析器の実行状態ごとの件数 (#301)。`ok` が 0 なら signal 0 件は「分析できなかった」。 */
  analyzerStatusCounts: Record<AnalyzerRunStatus, number>;
  signals: AggregateSignal[];
}

/** Tier S の三層保証 (ADR-0020)。 */
export interface AggregateAssurance {
  integrity: IntegrityLevel | AggregateOther;
  temporal: TemporalLevel | AggregateOther;
  provenance: {
    pureTyping: boolean;
    notableSignals: number | null;
    reviewPriority: number | null;
  };
}

/** 集計用の Tier S バンドル (ADR-0024、#304)。入れ子の名前は Tier A と揃えてある。 */
export interface AggregateBundle {
  schema: typeof AGGREGATE_BUNDLE_SCHEMA;
  notice: typeof DERIVED_VIEW_NOTICE;
  /** 派生元 proof が整合性検証を通ったか (Tier A の `integrityValid` の写し)。 */
  integrityValid: boolean;
  processSummary: AggregateProcessSummary;
  analysis: AggregateAnalysis;
  assurance: AggregateAssurance;
}

// 既知集合は Record<union, true> で書く: union に値が足されたら記入漏れを tsc が止める。
const DIMENSIONS: Record<AnalysisDimension, true> = {
  automation: true,
  'keystroke-content-consistency': true,
  'transcription-topology': true,
  'focus-burst-correlation': true,
};
const SEVERITIES: Record<AnalysisSeverity, true> = { info: true, notice: true, review: true };
const INTEGRITY_LEVELS: Record<IntegrityLevel, true> = { proven: true, partial: true, failed: true };
const TEMPORAL_LEVELS: Record<TemporalLevel, true> = {
  anchored: true,
  partial: true,
  unanchored: true,
  'exam-t0': true,
};

function oneOf<T extends string>(known: Record<T, true>, value: unknown): T | AggregateOther {
  return typeof value === 'string' && Object.hasOwn(known, value) ? (value as T) : 'other';
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function countStatuses(analyzerStatus: unknown): Record<AnalyzerRunStatus, number> {
  const counts: Record<AnalyzerRunStatus, number> = { ok: 0, failed: 0, timeout: 0, 'invalid-output': 0 };
  for (const entry of Object.values(record(analyzerStatus))) {
    const status = record(entry).status;
    if (typeof status === 'string' && Object.hasOwn(counts, status)) {
      counts[status as AnalyzerRunStatus] += 1;
    }
  }
  return counts;
}

/**
 * Tier A バンドルから Tier S の集計バンドルを作る (純粋・決定的)。
 *
 * 入力は書き換えない。出力のどの欄も入力のオブジェクトを参照しない (すべて新しく組み立てる)。
 */
export function toAggregateBundle(bundle: AnalysisBundle): AggregateBundle {
  const p = record(bundle.processSummary);
  const a = record(bundle.analysis);
  const s = record(bundle.assurance);
  const provenance = record(s.provenance);
  const signals = Array.isArray(a.signals) ? a.signals : [];

  return {
    schema: AGGREGATE_BUNDLE_SCHEMA,
    notice: DERIVED_VIEW_NOTICE,
    integrityValid: bundle.integrityValid === true,
    processSummary: {
      totalEvents: finiteOrNull(p.totalEvents),
      durationMs: finiteOrNull(p.durationMs),
      contentChangeCount: finiteOrNull(p.contentChangeCount),
      insertedChars: finiteOrNull(p.insertedChars),
      deletedChars: finiteOrNull(p.deletedChars),
      deletionRatio: finiteOrNull(p.deletionRatio),
      executionCount: finiteOrNull(p.executionCount),
      hasRunResults: p.hasRunResults === true,
      runSuccessCount: finiteOrNull(p.runSuccessCount),
      runFailureCount: finiteOrNull(p.runFailureCount),
      pauseCount: finiteOrNull(p.pauseCount),
      longestPauseMs: finiteOrNull(p.longestPauseMs),
      focusLossCount: finiteOrNull(p.focusLossCount),
      externalInputCount: finiteOrNull(p.externalInputCount),
    },
    analysis: {
      reviewPriority: finiteOrNull(a.reviewPriority),
      analyzerStatusCounts: countStatuses(a.analyzerStatus),
      signals: signals.map((raw): AggregateSignal => {
        const sig = record(raw);
        return {
          dimension: oneOf(DIMENSIONS, sig.dimension),
          severity: oneOf(SEVERITIES, sig.severity),
          score: finiteOrNull(sig.score),
          confidence: finiteOrNull(sig.confidence),
        };
      }),
    },
    assurance: {
      integrity: oneOf(INTEGRITY_LEVELS, s.integrity),
      temporal: oneOf(TEMPORAL_LEVELS, s.temporal),
      provenance: {
        pureTyping: provenance.pureTyping === true,
        notableSignals: finiteOrNull(provenance.notableSignals),
        reviewPriority: finiteOrNull(provenance.reviewPriority),
      },
    },
  };
}
