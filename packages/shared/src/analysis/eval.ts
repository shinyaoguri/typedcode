/**
 * 分析器の実証評価 (W5, ADR-0009 の運用ゲート)。
 *
 * 目的: ラベル付きコーパス (genuine / automated) に対して分析層 (`AnalysisReport`) が
 * どれだけ「当てる/誤る」かを **混同行列と閾値スイープで定量化**し、heuristic 分析器を
 * severity `review` に昇格してよいか (= 偽陽性率が許容内か) を実測で判断する土台。
 *
 * 重要な原則:
 * - これは分析器を **判定器に変えるものではない** (ADR-0009: 分析は advisory)。
 *   評価が言うのは「この手掛かりを review 扱いにしたとき、本物の人間をどれだけ巻き込むか」だけ。
 * - **headline 指標は genuineSignalRate** (本物コーパスが notice/review を出してしまう率)。
 *   ここが高い手掛かりは、どんな閾値でも review に上げてはならない。
 * - 純粋・決定的 (同じ入力 → 同じ出力)。乱数も時計も使わない。
 *
 * パイプライン: ラベル付き proof → `runAnalysis` → `LabeledAnalysis[]` → `evaluateAnalysis`。
 * 収集プロトコルと実行手順は docs/analysis-eval-protocol.md。
 */

import type { AnalysisDimension, AnalysisReport, AnalysisSeverity } from './types.js';

/** コーパスの 1 件に与える正解ラベル。 */
export type EvalLabel = 'genuine' | 'automated';

/** 評価対象の 1 件: ラベル + その proof に対する分析レポート。 */
export interface LabeledAnalysis {
  /** proof の識別子 (ファイル名等。レポートの突合用)。 */
  id: string;
  label: EvalLabel;
  /** 収集条件タグ (例: 'genuine-ime', 'ai-paste', 'transcribe-noime')。任意。 */
  condition?: string;
  report: AnalysisReport;
}

/** ある閾値での混同行列と派生指標。positive = 「automated と予測」。 */
export interface ConfusionPoint {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** tp/(tp+fp)。陽性予測ゼロのときは 1 (誤報なし) とする。 */
  precision: number;
  /** tp/(tp+fn)。automated ゼロのときは 0。 */
  recall: number;
  /** 2PR/(P+R)。P=R=0 のときは 0。 */
  f1: number;
  /** fp/(fp+tn) = 偽陽性率。genuine ゼロのときは 0。これが昇格可否の鍵。 */
  fpr: number;
}

/** 1 つの評価軸 (各 dimension または overall) のスイープ結果。 */
export interface DimensionEval {
  /** 'overall' は reviewPriority、各 dimension は当該次元の最大 signal score を予測スコアに使う。 */
  axis: AnalysisDimension | 'overall';
  sweep: ConfusionPoint[];
  /** F1 最大の点 (同点なら閾値が小さい方)。 */
  bestF1: ConfusionPoint;
  /**
   * FPR 上限 (`maxFpr`) を満たす中で recall 最大の点。常に 1 つは存在する
   * (十分高い閾値は何も陽性にしないので fpr=0)。これが「review に上げてよい閾値」の候補。
   */
  recommended: ConfusionPoint;
}

/** genuine コーパスのうち各 severity 以上の signal を出した割合 (偽陽性圧)。 */
export interface GenuineSignalRate {
  /** info も含め何らかの signal が出た割合。 */
  anySignal: number;
  /** notice 以上の signal が出た割合。 */
  notice: number;
  /** review の signal が出た割合 (= 現状の分析器が本物を review 扱いする率)。 */
  review: number;
}

/** 評価レポート全体。 */
export interface EvalReport {
  corpus: {
    total: number;
    genuine: number;
    automated: number;
    byCondition: Record<string, { genuine: number; automated: number }>;
  };
  /** 誠実な headline 指標。高ければどんな閾値でも review 昇格は不可。 */
  genuineSignalRate: GenuineSignalRate;
  /** overall + 各 dimension の軸別評価。 */
  axes: DimensionEval[];
  /** recommended を選ぶときの FPR 上限。 */
  maxFpr: number;
}

export interface EvaluateOptions {
  /** 予測スコアの閾値群 (昇順)。既定は 0.05..1.00 を 0.05 刻み。 */
  thresholds?: number[];
  /** recommended が満たすべき偽陽性率の上限。既定 0.05。 */
  maxFpr?: number;
}

const ALL_DIMENSIONS: AnalysisDimension[] = [
  'automation',
  'keystroke-content-consistency',
  'transcription-topology',
  'focus-burst-correlation',
];

const SEVERITY_RANK: Record<AnalysisSeverity, number> = { info: 0, notice: 1, review: 2 };

function defaultThresholds(): number[] {
  const out: number[] = [];
  // 0.05 刻み。0 は「signal 皆無の proof まで陽性化」してしまうため含めない。
  for (let i = 1; i <= 20; i++) out.push(Math.round(i * 0.05 * 100) / 100);
  return out;
}

/** ある proof の、指定軸での予測スコア。overall は reviewPriority、dimension は最大 signal score。 */
function axisScore(report: AnalysisReport, axis: AnalysisDimension | 'overall'): number {
  if (axis === 'overall') return report.reviewPriority;
  let max = 0;
  for (const s of report.signals) {
    if (s.dimension === axis && s.score > max) max = s.score;
  }
  return max;
}

/** proof が出した signal の最大 severity ランク (-1 = signal なし)。 */
function maxSeverityRank(report: AnalysisReport): number {
  let rank = -1;
  for (const s of report.signals) {
    const r = SEVERITY_RANK[s.severity];
    if (r > rank) rank = r;
  }
  return rank;
}

function confusionAt(
  items: LabeledAnalysis[],
  axis: AnalysisDimension | 'overall',
  threshold: number
): ConfusionPoint {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const item of items) {
    const score = axisScore(item.report, axis);
    // 陽性予測 = score が閾値以上 かつ score>0 (signal の無い proof は決して陽性化しない)。
    const predictedAutomated = score > 0 && score >= threshold;
    const actualAutomated = item.label === 'automated';
    if (predictedAutomated && actualAutomated) tp++;
    else if (predictedAutomated && !actualAutomated) fp++;
    else if (!predictedAutomated && !actualAutomated) tn++;
    else fn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  return { threshold, tp, fp, tn, fn, precision, recall, f1, fpr };
}

function evaluateAxis(
  items: LabeledAnalysis[],
  axis: AnalysisDimension | 'overall',
  thresholds: number[],
  maxFpr: number
): DimensionEval {
  const sweep = thresholds.map((t) => confusionAt(items, axis, t));

  // F1 最大 (同点は閾値が小さい方を優先 = recall を取りこぼさない)。
  let bestF1 = sweep[0]!;
  for (const p of sweep) {
    if (p.f1 > bestF1.f1) bestF1 = p;
  }

  // FPR 上限を満たす中で recall 最大 (同点は閾値が大きい = より保守的な方)。
  let recommended: ConfusionPoint | null = null;
  for (const p of sweep) {
    if (p.fpr > maxFpr) continue;
    if (
      recommended === null ||
      p.recall > recommended.recall ||
      (p.recall === recommended.recall && p.threshold > recommended.threshold)
    ) {
      recommended = p;
    }
  }
  // FPR<=maxFpr を満たす点が無いことは原理上ありえない (最大閾値超の点が無い場合に備え保険)。
  if (recommended === null) {
    recommended = sweep.reduce((a, b) => (b.fpr < a.fpr ? b : a), sweep[0]!);
  }

  return { axis, sweep, bestF1, recommended };
}

/**
 * ラベル付きコーパスから分析層の評価レポートを計算する (純粋関数)。
 *
 * @param items genuine/automated ラベル付きの分析レポート列。
 * @param opts  閾値群と FPR 上限。
 */
export function evaluateAnalysis(items: LabeledAnalysis[], opts: EvaluateOptions = {}): EvalReport {
  const thresholds = opts.thresholds ?? defaultThresholds();
  const maxFpr = opts.maxFpr ?? 0.05;

  const genuine = items.filter((i) => i.label === 'genuine');
  const automated = items.filter((i) => i.label === 'automated');

  const byCondition: Record<string, { genuine: number; automated: number }> = {};
  for (const item of items) {
    const key = item.condition ?? '(none)';
    const bucket = (byCondition[key] ??= { genuine: 0, automated: 0 });
    if (item.label === 'genuine') bucket.genuine++;
    else bucket.automated++;
  }

  // genuineSignalRate: 本物コーパスが各 severity 以上を出した割合。
  const gN = genuine.length;
  const genuineSignalRate: GenuineSignalRate = {
    anySignal: gN === 0 ? 0 : genuine.filter((g) => maxSeverityRank(g.report) >= SEVERITY_RANK.info).length / gN,
    notice: gN === 0 ? 0 : genuine.filter((g) => maxSeverityRank(g.report) >= SEVERITY_RANK.notice).length / gN,
    review: gN === 0 ? 0 : genuine.filter((g) => maxSeverityRank(g.report) >= SEVERITY_RANK.review).length / gN,
  };

  const axes: DimensionEval[] = [
    evaluateAxis(items, 'overall', thresholds, maxFpr),
    ...ALL_DIMENSIONS.map((d) => evaluateAxis(items, d, thresholds, maxFpr)),
  ];

  return {
    corpus: { total: items.length, genuine: genuine.length, automated: automated.length, byCondition },
    genuineSignalRate,
    axes,
    maxFpr,
  };
}

/** 評価レポートを人間可読な Markdown に整形する (CLI/ドキュメント貼付用)。 */
export function formatEvalReportMarkdown(report: EvalReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push('# 分析器 実証評価レポート (ADR-0009 / W5)');
  lines.push('');
  lines.push('> 分析は advisory。この評価は「手掛かりを review 扱いにしたとき本物の人間をどれだけ巻き込むか」を測るもので、分析器を判定器に変えるものではない。');
  lines.push('');
  lines.push('## コーパス構成');
  lines.push('');
  lines.push(`- 総数: ${report.corpus.total} (genuine ${report.corpus.genuine} / automated ${report.corpus.automated})`);
  for (const [cond, c] of Object.entries(report.corpus.byCondition)) {
    lines.push(`  - ${cond}: genuine ${c.genuine}, automated ${c.automated}`);
  }
  lines.push('');
  lines.push('## genuine コーパスの偽陽性圧 (headline)');
  lines.push('');
  lines.push('本物の人間タイピングが各 severity 以上の signal を出してしまった割合。**review が 0% でない手掛かりは、その閾値で review へ昇格してはならない。**');
  lines.push('');
  lines.push(`- 何らかの signal: ${pct(report.genuineSignalRate.anySignal)}`);
  lines.push(`- notice 以上: ${pct(report.genuineSignalRate.notice)}`);
  lines.push(`- review: ${pct(report.genuineSignalRate.review)}`);
  lines.push('');
  lines.push(`## 軸別スイープ (FPR 上限 ${pct(report.maxFpr)})`);
  lines.push('');
  for (const axis of report.axes) {
    lines.push(`### ${axis.axis}`);
    lines.push('');
    lines.push(`- 最良 F1: 閾値 ${axis.bestF1.threshold} → P ${pct(axis.bestF1.precision)} / R ${pct(axis.bestF1.recall)} / F1 ${pct(axis.bestF1.f1)} / FPR ${pct(axis.bestF1.fpr)}`);
    lines.push(`- 推奨閾値 (FPR≤${pct(report.maxFpr)}): ${axis.recommended.threshold} → R ${pct(axis.recommended.recall)} / FPR ${pct(axis.recommended.fpr)} (tp ${axis.recommended.tp}, fp ${axis.recommended.fp}, fn ${axis.recommended.fn}, tn ${axis.recommended.tn})`);
    lines.push('');
  }
  return lines.join('\n');
}
