/**
 * 分析層 (ADR-0009) の orchestrator。
 *
 * 分析器群を走らせて `AnalysisReport` を組み立てるだけの薄い器。
 * 分析器を差し替えれば分析内容を丸ごと入れ替えられる (既定は `defaultAnalyzers`)。
 */

import type { AnalysisInput, AnalysisReport, AnalysisSeverity, AnalysisSignal, Analyzer } from './types.js';
import type { ExportedProof, StoredEvent } from '../types/proof.js';
import { pickHashedEventFields } from '../verification.js';
import { defaultAnalyzers } from './analyzers/index.js';

/** severity 別の要確認寄与の重み。`info` は寄与しない。 */
const SEVERITY_WEIGHT: Record<AnalysisSeverity, number> = {
  info: 0,
  notice: 0.5,
  review: 1,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 1 signal の「要確認」寄与度 = severity 重み × score × confidence。
 * (暫定の集約式。本格的な重み付けは後続。)
 */
function signalContribution(signal: AnalysisSignal): number {
  return SEVERITY_WEIGHT[signal.severity] * clamp01(signal.score) * clamp01(signal.confidence);
}

/**
 * イベントを「ハッシュ対象フィールドだけ」に射影する (#328)。
 *
 * `description` / `insertLength` / `selectedText` などはハッシュに入らず、proof.json を書き換えても
 * チェーン検証が通ってしまう。分析器がそれを読むと、検証済みでも攻撃者が結果を左右できるので、
 * 入口で落として **分析器が署名対象の事実だけを見る** ことを構造で保証する。非ハッシュ対象の
 * フィールドは `null` にし (型は `StoredEvent` のまま)、`hash` はチェーン検証の出力としてそのまま残す。
 * 元の proof は変更しない。
 */
function projectProofToHashedEvents(proof: ExportedProof): ExportedProof {
  const events = proof.proof?.events;
  if (!Array.isArray(events)) return proof;
  const projected: StoredEvent[] = events.map((event) => ({
    ...pickHashedEventFields(event),
    posw: event.posw,
    hash: event.hash,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  }));
  return { ...proof, proof: { ...proof.proof, events: projected } };
}

/**
 * 分析器群を走らせて `AnalysisReport` を組み立てる (ADR-0009)。
 *
 * - `analyzers` を差し替えれば分析内容を丸ごと入れ替えられる (既定は `defaultAnalyzers`)。
 * - 分析器へ渡す proof のイベントは **ハッシュ対象フィールドだけ**に射影される (#328)。
 * - ある分析器が throw しても他を止めない (best-effort / graceful)。
 * - `reviewPriority` は signal 寄与度の **最大値** (一本でも強い手掛かりがあれば優先)。
 *   **判定ではない**。
 */
export async function runAnalysis(
  rawInput: AnalysisInput,
  analyzers: readonly Analyzer[] = defaultAnalyzers
): Promise<AnalysisReport> {
  const input = { ...rawInput, proof: projectProofToHashedEvents(rawInput.proof) };
  const signals: AnalysisSignal[] = [];
  const analyzerVersions: Record<string, string> = {};

  for (const analyzer of analyzers) {
    analyzerVersions[analyzer.id] = analyzer.version;
    try {
      const produced = await analyzer.analyze(input);
      for (const signal of produced) signals.push(signal);
    } catch {
      // 分析は best-effort。1 つの分析器の失敗で全体を落とさない。
      // (失敗自体を signal 化するかは後続課題。)
    }
  }

  const reviewPriority = signals.reduce((max, signal) => Math.max(max, signalContribution(signal)), 0);

  return { analyzerVersions, signals, reviewPriority };
}
