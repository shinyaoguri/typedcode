/**
 * 分析層 (ADR-0009): 検証と **直交** する pluggable な人間らしさ / 異常度分析の「器」。
 *
 * `Analyzer` を差すだけで増減・差し替え可能。アルゴリズムの中身は後続 spec/ADR。
 * 既定の分析器 (`defaultAnalyzers`) は方向性を示すプレースホルダのみ。
 */

export type {
  AnalysisDimension,
  AnalysisSeverity,
  EvidenceRef,
  AnalysisSignal,
  AnalysisInput,
  Analyzer,
  AnalysisReport,
} from './types.js';

export { runAnalysis } from './orchestrator.js';
export {
  defaultAnalyzers,
  automationAnalyzer,
  transcriptionTopologyAnalyzer,
  focusBurstAnalyzer,
  pureTypingAnalyzer,
} from './analyzers/index.js';

export { buildAnalysisBundle, ANALYSIS_BUNDLE_SCHEMA } from './bundle.js';
export type { AnalysisBundle } from './bundle.js';

export {
  computeCohortBaseline,
  positionInCohort,
  COHORT_MIN_N,
  COHORT_BASELINE_SCHEMA,
  COHORT_POSITION_SCHEMA,
} from './cohort.js';
export type {
  CohortMetricKey,
  MetricDistribution,
  CohortBaseline,
  MetricPosition,
  CohortPosition,
} from './cohort.js';

export { evaluateAnalysis, formatEvalReportMarkdown } from './eval.js';
export type {
  EvalLabel,
  LabeledAnalysis,
  ConfusionPoint,
  DimensionEval,
  GenuineSignalRate,
  EvalReport,
  EvaluateOptions,
} from './eval.js';
