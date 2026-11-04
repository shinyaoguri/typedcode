/**
 * 分析層 (ADR-0009) の orchestrator。
 *
 * 分析器群を走らせて `AnalysisReport` を組み立てるだけの薄い器。
 * 分析器を差し替えれば分析内容を丸ごと入れ替えられる (既定は `defaultAnalyzers`)。
 */

import type {
  AnalysisInput,
  AnalysisReport,
  AnalysisSeverity,
  AnalysisSignal,
  Analyzer,
  AnalyzerStatus,
} from './types.js';
import type { ExportedProof, StoredEvent } from '../types/proof.js';
import { pickHashedEventFields } from '../verification.js';
import { defaultAnalyzers } from './analyzers/index.js';

/**
 * 分析器 1 つあたりの既定の期限 (ms, #301)。既定の分析器は 1 proof あたり ms オーダーで終わるので、
 * これを超えるのは解決しない Promise (await 忘れ・応答しない外部 API 待ち) とみなす。
 * 期限を過ぎた分析器は `timeout` として記録し、後から解決しても結果は捨てる。
 */
export const ANALYZER_TIMEOUT_MS = 10_000;

/** `AnalyzerStatus.message` の最大長。外部分析器の例外メッセージは未信頼で、長さも決められるため切る。 */
const MAX_STATUS_MESSAGE_LENGTH = 200;

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
  // severity は isValidSignal が 3 値に絞ってあるが、未知の値が来ても NaN にしない (#301)。
  const weight = SEVERITY_WEIGHT[signal.severity] ?? 0;
  return weight * clamp01(signal.score) * clamp01(signal.confidence);
}

function isSeverity(value: unknown): value is AnalysisSeverity {
  return value === 'info' || value === 'notice' || value === 'review';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * signal が契約 (`AnalysisSignal`) に合うか (#301)。分析器の出力は外部コードが決められるので、
 * 集約 (`reviewPriority`) と表示が前提にする欄だけを見る。finite だが 0..1 の外にある score /
 * confidence は不正にせず、従来どおり集約時に clamp する。
 */
function isValidSignal(value: unknown): value is AnalysisSignal {
  if (typeof value !== 'object' || value === null) return false;
  const signal = value as Record<string, unknown>;
  return (
    isSeverity(signal['severity']) &&
    isFiniteNumber(signal['score']) &&
    isFiniteNumber(signal['confidence']) &&
    Array.isArray(signal['evidence']) &&
    typeof signal['summary'] === 'string'
  );
}

/** 例外などを `AnalyzerStatus.message` 用の短い文字列にする。文字列化そのものの失敗も握る。 */
function describeError(error: unknown): string {
  let text: string;
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    text = 'unprintable error';
  }
  return text.length > MAX_STATUS_MESSAGE_LENGTH ? `${text.slice(0, MAX_STATUS_MESSAGE_LENGTH)}…` : text;
}

type AnalyzerOutcome =
  | { kind: 'resolved'; value: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' };

/**
 * 分析器を期限付きで 1 回走らせる。決着 (解決・失敗・期限切れ) のどれかで必ず resolve する。
 *
 * - `analyze()` は Promise の中で呼ぶので、同期の throw も `rejected` として拾える
 * - 決着したら必ず `clearTimeout` する。タイマーを残すと、CLI の自然終了 (verify-cli の不変条件 2) が
 *   最大で期限ぶん遅れる
 * - 期限切れの後に分析器が解決しても、その結果は捨てる (`settled` で一度きりにする)
 * - 期限は非同期の待ちにしか効かない。同期の無限ループはこの関数ごと止まる (外部分析器は信頼済みの前提)
 */
function runWithDeadline(analyzer: Analyzer, input: AnalysisInput, timeoutMs: number): Promise<AnalyzerOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: AnalyzerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
    try {
      Promise.resolve(analyzer.analyze(input)).then(
        (value) => settle({ kind: 'resolved', value }),
        (error: unknown) => settle({ kind: 'rejected', error })
      );
    } catch (error) {
      settle({ kind: 'rejected', error });
    }
  });
}

/** 分析器 1 つの結果を、残す signal と状態に畳む。 */
function collectOutcome(
  analyzer: Analyzer,
  outcome: AnalyzerOutcome,
  timeoutMs: number,
  signals: AnalysisSignal[]
): AnalyzerStatus {
  const version = analyzer.version;
  if (outcome.kind === 'timeout') {
    return { version, status: 'timeout', message: `did not settle within ${timeoutMs} ms` };
  }
  if (outcome.kind === 'rejected') {
    return { version, status: 'failed', message: describeError(outcome.error) };
  }
  const produced = outcome.value;
  if (!Array.isArray(produced)) {
    return { version, status: 'invalid-output', message: 'analyze() did not return an array', discardedSignals: 0 };
  }
  let discarded = 0;
  for (let i = 0; i < produced.length; i++) {
    const candidate: unknown = produced[i];
    if (isValidSignal(candidate)) {
      signals.push(candidate);
    } else {
      discarded++;
    }
  }
  if (discarded > 0) {
    return {
      version,
      status: 'invalid-output',
      message: `discarded ${discarded} signal(s) that do not match the AnalysisSignal contract`,
      discardedSignals: discarded,
    };
  }
  return { version, status: 'ok' };
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

/** `runAnalysis` の任意設定。 */
export interface RunAnalysisOptions {
  /** 分析器 1 つあたりの期限 (ms)。既定は `ANALYZER_TIMEOUT_MS`。テストと検証の呼び出し側の継ぎ目。 */
  timeoutMs?: number;
}

/**
 * 分析器群を走らせて `AnalysisReport` を組み立てる (ADR-0009)。
 *
 * - `analyzers` を差し替えれば分析内容を丸ごと入れ替えられる (既定は `defaultAnalyzers`)。
 * - 分析器へ渡す proof のイベントは **ハッシュ対象フィールドだけ**に射影される (#328)。
 * - 分析器は 1 つずつ期限付きで走らせる。throw・期限切れ・契約に合わない出力は他を止めず、
 *   `analyzerStatus` に `failed` / `timeout` / `invalid-output` として残す (#301)。失敗を signal にしない
 *   (signal 0 件の「手掛かりなし」と区別するため)。
 * - 不正な signal は捨て、`reviewPriority` にも寄与させない (壊れた出力が要確認度を最大にしないため)。
 * - `reviewPriority` は signal 寄与度の **最大値** (一本でも強い手掛かりがあれば優先)。
 *   **判定ではない**。
 */
export async function runAnalysis(
  rawInput: AnalysisInput,
  analyzers: readonly Analyzer[] = defaultAnalyzers,
  options: RunAnalysisOptions = {}
): Promise<AnalysisReport> {
  const timeoutMs = options.timeoutMs ?? ANALYZER_TIMEOUT_MS;
  const input = { ...rawInput, proof: projectProofToHashedEvents(rawInput.proof) };
  const signals: AnalysisSignal[] = [];
  const analyzerVersions: Record<string, string> = {};
  const analyzerStatus: Record<string, AnalyzerStatus> = {};

  for (const analyzer of analyzers) {
    analyzerVersions[analyzer.id] = analyzer.version;
    const outcome = await runWithDeadline(analyzer, input, timeoutMs);
    analyzerStatus[analyzer.id] = collectOutcome(analyzer, outcome, timeoutMs, signals);
  }

  const reviewPriority = signals.reduce((max, signal) => Math.max(max, signalContribution(signal)), 0);

  return { analyzerVersions, analyzerStatus, signals, reviewPriority };
}
