/**
 * 採点者向けコホート基準 (ADR-0025 の実装)。
 *
 * 1 件の過程要約は単独では読めない (「45 分は速いのか」はコホート分布に対してのみ意味を持つ)。
 * 採点者が**集団内のどこに位置するか**で注意を配分するための、content-free な集約分布を計算する。
 *
 * 入力は Tier A の `AnalysisBundle[]` (ADR-0024)。ソース・打鍵文字・fingerprint は含まれない。
 *
 * 重要な不変条件 (ADR-0025):
 * - **advisory のみ。** 外れ値は triage の手掛かりであって違反ではない。判定でも valid 反映でもない。
 * - **集約のみを保持する。** Baseline に個票・識別子を残さない (コホート内プライバシー)。
 * - **記述的であって規範ではない。** 「コホートと違う」は欠陥を意味しない (IME/支援技術/速度の
 *   多様性は正当な外れ値 — docs/accessibility-accommodation-policy.md と併読)。
 * - **頑健統計 + 小 N ガード。** 中央値/IQR を主に、`n` を併記し、小さいコホートは `sufficient:false`。
 * - 純粋・決定的 (乱数・時計を使わない)。
 */

import type { AnalysisBundle } from './bundle.js';

/** これ未満のコホートでは分布が誤導しやすい (ADR-0025 §5)。位置表示側で警告する。 */
export const COHORT_MIN_N = 5;

export const COHORT_BASELINE_SCHEMA = 'cohort-baseline/1' as const;
export const COHORT_POSITION_SCHEMA = 'cohort-position/1' as const;

/** 分布対象の content-free な数値メトリクス (ProcessSummary + reviewPriority)。 */
export type CohortMetricKey =
  | 'durationMs'
  | 'contentChangeCount'
  | 'insertedChars'
  | 'deletedChars'
  | 'deletionRatio'
  | 'executionCount'
  | 'runSuccessCount'
  | 'runFailureCount'
  | 'pauseCount'
  | 'longestPauseMs'
  | 'focusLossCount'
  | 'externalInputCount'
  | 'reviewPriority';

const METRIC_KEYS: readonly CohortMetricKey[] = [
  'durationMs',
  'contentChangeCount',
  'insertedChars',
  'deletedChars',
  'deletionRatio',
  'executionCount',
  'runSuccessCount',
  'runFailureCount',
  'pauseCount',
  'longestPauseMs',
  'focusLossCount',
  'externalInputCount',
  'reviewPriority',
];

/** 1 メトリクスの頑健分布要約。個票は持たない。 */
export interface MetricDistribution {
  /** 非 null の寄与数 (deletionRatio / longestPauseMs は null になりうる)。 */
  n: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
}

/** コホート基準。集約のみ (ADR-0025 不変条件)。 */
export interface CohortBaseline {
  schema: typeof COHORT_BASELINE_SCHEMA;
  /** バンドル総数。 */
  cohortSize: number;
  /** `cohortSize >= COHORT_MIN_N`。false のとき percentile は誤導しやすい。 */
  sufficient: boolean;
  /** メトリクスごとの分布。寄与ゼロ (全 null) のメトリクスは欠落。 */
  metrics: Partial<Record<CohortMetricKey, MetricDistribution>>;
  /** 分析次元ごとの base rate = notable signal (severity !== 'info') を出したバンドルの割合 0..1。 */
  dimensionSignalRate: Record<string, number>;
}

/** 1 メトリクスの、ある提出のコホート内位置。 */
export interface MetricPosition {
  value: number;
  /** midrank パーセンタイル 0..100 (= 自分以下の割合)。 */
  percentile: number;
  /** 箱 (q1..q3) からの IQR 単位距離。box 内は 0、下振れ負・上振れ正。iqr=0 のとき null。 */
  iqrPosition: number | null;
}

/** ある提出のコホート内位置。すべて advisory な triage。 */
export interface CohortPosition {
  schema: typeof COHORT_POSITION_SCHEMA;
  /** baseline.sufficient の写し (UI 警告用)。 */
  sufficient: boolean;
  cohortSize: number;
  metrics: Partial<Record<CohortMetricKey, MetricPosition>>;
  /** 次元ごとに、この提出が signal を出したか + コホート base rate。 */
  dimensions: Record<string, { fired: boolean; baseRate: number }>;
}

// ============================================================================
// 抽出
// ============================================================================

function extractMetrics(bundle: AnalysisBundle): Record<CohortMetricKey, number | null> {
  const p = bundle.processSummary;
  return {
    durationMs: p.durationMs,
    contentChangeCount: p.contentChangeCount,
    insertedChars: p.insertedChars,
    deletedChars: p.deletedChars,
    deletionRatio: p.deletionRatio,
    executionCount: p.executionCount,
    runSuccessCount: p.runSuccessCount,
    runFailureCount: p.runFailureCount,
    pauseCount: p.pauseCount,
    longestPauseMs: p.longestPauseMs,
    focusLossCount: p.focusLossCount,
    externalInputCount: p.externalInputCount,
    reviewPriority: bundle.analysis.reviewPriority,
  };
}

/** このバンドルで notable signal (severity !== 'info') を出した次元の集合。 */
function notableDimensions(bundle: AnalysisBundle): Set<string> {
  const dims = new Set<string>();
  for (const s of bundle.analysis.signals) {
    if (s.severity !== 'info') dims.add(s.dimension);
  }
  return dims;
}

// ============================================================================
// 頑健統計 (純粋)
// ============================================================================

/** 昇順ソート済み配列の type-7 分位点 (numpy/R-7 既定)。n>=1 前提。 */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

function distributionOf(values: number[]): MetricDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  return {
    n: sorted.length,
    median: quantileSorted(sorted, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/** midrank パーセンタイル: (自分未満 + 0.5×同値) / n × 100。 */
function percentileRank(sorted: number[], value: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  let less = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) less++;
    else if (v === value) equal++;
  }
  return ((less + 0.5 * equal) / n) * 100;
}

// ============================================================================
// 公開 API
// ============================================================================

/**
 * Tier A バンドル群からコホート基準を計算する (純粋・決定的)。
 * 個票は保持せず、メトリクスごとの頑健統計と次元 base rate のみを返す。
 */
export function computeCohortBaseline(bundles: readonly AnalysisBundle[]): CohortBaseline {
  const cohortSize = bundles.length;

  // メトリクスごとに非 null 値を集める。
  const columns: Record<CohortMetricKey, number[]> = Object.fromEntries(
    METRIC_KEYS.map((k) => [k, [] as number[]])
  ) as Record<CohortMetricKey, number[]>;

  const dimensionCounts: Record<string, number> = {};

  for (const bundle of bundles) {
    const m = extractMetrics(bundle);
    for (const key of METRIC_KEYS) {
      const v = m[key];
      if (v !== null && Number.isFinite(v)) columns[key].push(v);
    }
    for (const dim of notableDimensions(bundle)) {
      dimensionCounts[dim] = (dimensionCounts[dim] ?? 0) + 1;
    }
  }

  const metrics: Partial<Record<CohortMetricKey, MetricDistribution>> = {};
  for (const key of METRIC_KEYS) {
    const values = columns[key];
    if (values.length > 0) metrics[key] = distributionOf(values);
  }

  const dimensionSignalRate: Record<string, number> = {};
  for (const [dim, count] of Object.entries(dimensionCounts)) {
    dimensionSignalRate[dim] = cohortSize === 0 ? 0 : count / cohortSize;
  }

  return {
    schema: COHORT_BASELINE_SCHEMA,
    cohortSize,
    sufficient: cohortSize >= COHORT_MIN_N,
    metrics,
    dimensionSignalRate,
  };
}

/**
 * ある提出 (バンドル) のコホート内位置を計算する (純粋・決定的)。advisory な triage のみ。
 *
 * 注意: baseline は値の分布要約しか持たないため、percentile は提出値が分布の中央値・四分位
 * に対してどこかを示す近似であって、元コホートへの厳密 midrank ではない (個票非保持の代償)。
 */
export function positionInCohort(bundle: AnalysisBundle, baseline: CohortBaseline): CohortPosition {
  const m = extractMetrics(bundle);
  const metrics: Partial<Record<CohortMetricKey, MetricPosition>> = {};

  for (const key of METRIC_KEYS) {
    const value = m[key];
    const dist = baseline.metrics[key];
    if (value === null || !Number.isFinite(value) || dist === undefined) continue;

    // baseline は五数 (min/q1/median/q3/max) のみ保持するので、その代表点で midrank を近似する。
    const anchors = [dist.min, dist.q1, dist.median, dist.q3, dist.max].sort((a, b) => a - b);
    const percentile = percentileRank(anchors, value);

    let iqrPosition: number | null;
    if (dist.iqr === 0) {
      iqrPosition = null;
    } else if (value < dist.q1) {
      iqrPosition = (value - dist.q1) / dist.iqr;
    } else if (value > dist.q3) {
      iqrPosition = (value - dist.q3) / dist.iqr;
    } else {
      iqrPosition = 0;
    }

    metrics[key] = { value, percentile, iqrPosition };
  }

  const fired = notableDimensions(bundle);
  const dimensions: Record<string, { fired: boolean; baseRate: number }> = {};
  // baseline が知る次元 ∪ この提出が出した次元、の和集合を対象にする。
  const allDims = new Set<string>([...Object.keys(baseline.dimensionSignalRate), ...fired]);
  for (const dim of allDims) {
    dimensions[dim] = {
      fired: fired.has(dim),
      baseRate: baseline.dimensionSignalRate[dim] ?? 0,
    };
  }

  return {
    schema: COHORT_POSITION_SCHEMA,
    sufficient: baseline.sufficient,
    cohortSize: baseline.cohortSize,
    metrics,
    dimensions,
  };
}
