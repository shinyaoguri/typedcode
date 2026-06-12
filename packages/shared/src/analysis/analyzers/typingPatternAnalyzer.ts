/**
 * 打鍵動態 (keystroke dynamics) を分析層 (ADR-0009) の signal に折り込む分析器。
 *
 * 旧 `TypingPatternCard` (verify) が単独で描いていた `TypingPatternAnalyzer` の所見を、
 * ADR-0009 の framework に寄せたもの (旧カードは廃止)。Dwell/Flight タイミング・リズム規則性
 * 等から「人間らしさ」を見るが、**判定はしない** — issue を `keystroke-content-consistency`
 * 次元の advisory signal として出すだけ。
 *
 * 重要:
 * - **judgment スコアゲージ (human/uncertain/suspicious) は持ち込まない** (ADR-0023 非判定)。
 *   出すのは issue ベースの手掛かりのみ。
 * - **W5 ゲート**: heuristic は実測まで `review` に上げない → critical でも `notice` 止まり。
 * - **IME / 支援技術への配慮** (★6b): IME 変換や音声入力・低速入力は打鍵動態を歪め、本分析を
 *   誤って踏みうる。だからこそ advisory 限定・低めの severity に留める。解釈は
 *   docs/accessibility-accommodation-policy.md と併読。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer, AnalysisSeverity } from '../types.js';
import { TypingPatternAnalyzer } from '../../typingPattern/TypingPatternAnalyzer.js';
import type { IssueSeverity } from '../../types/typingPattern.js';

const ID = 'typing-pattern';

/**
 * 打鍵動態 (Dwell Time) サンプルがこれ未満の proof では分析の基盤が無いので黙る。
 * `TypingPatternAnalyzer` の minEventsRequired は **totalEvents** を見るため、ペースト主体や
 * keyDown/keyUp を持たない proof でも閾値を超えて「空のタイミング」から所見を出しうる。
 * keystroke timing が乏しい (= 判断材料が無い) ときに誤って踏まないためのガード (★6b 配慮)。
 */
const MIN_KEYSTROKE_SAMPLES = 30;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** issue severity → signal severity。**critical でも notice 止まり** (W5 ゲート: heuristic を review に上げない)。 */
function mapSeverity(severity: IssueSeverity): AnalysisSeverity {
  return severity === 'critical' ? 'notice' : 'info';
}

export const typingPatternAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const events = input.proof.proof?.events ?? [];
    const analysis = new TypingPatternAnalyzer().analyze(events);

    // 打鍵動態サンプルが乏しい proof は判断材料が無いので黙る (★6b 配慮)。
    if (analysis.rawStats.dwellTimes.length < MIN_KEYSTROKE_SAMPLES) return [];

    // 試料不足 (confidence 0 = createInsufficientDataResult) や所見ゼロは黙る
    // (他アナライザと同じ保守姿勢。clean な proof で signal を出さない)。
    if (analysis.confidence === 0 || analysis.issues.length === 0) return [];

    const confidence = clamp01(analysis.confidence / 100);

    // issue ごとに 1 signal。score は当該メトリクスの「人間らしさ」スコアの裏返し (異常度)。
    return analysis.issues.map((issue) => {
      const metricScore = analysis.metrics[issue.metric]?.score ?? 50;
      return {
        analyzerId: ID,
        dimension: 'keystroke-content-consistency',
        score: clamp01(1 - metricScore / 100),
        confidence,
        severity: mapSeverity(issue.severity),
        evidence: [],
        summary: issue.message,
        summaryKey: issue.messageKey,
      };
    });
  },
};
