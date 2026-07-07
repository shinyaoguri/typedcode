/**
 * 既定で公開してよい (= 開示しても evasion を大きく助けない) 分析器。
 *
 * ADR-0009 の次元の第一次ヒューリスティック + 既存 advisory の折り込み:
 * - `automation`                   : 自動化ブラウザの環境 tell (webdriver / 自動化グローバル / headless renderer)
 * - `transcription-topology`       : 修正 (削除) の少なさ
 * - `focus-burst`                  : 長い離脱 → 復帰直後の大量入力
 * - `pureTyping`                   : 既存 `isPureTyping` advisory の折り込み
 * - `typing-pattern` (keystroke-content-consistency) : 打鍵動態 (Dwell/Flight・リズム) の所見
 *
 * いずれも **第一次ヒューリスティックで低 confidence・advisory のみ**。感度の高い本物の分析器
 * (重み/閾値を秘匿したいもの) は採点者側に private で足す想定。
 * 差し替え方: `runAnalysis(input, [myAnalyzer, ...defaultAnalyzers])`。
 *
 * NOTE: keystroke↔content 整合の「挿入文字数 ÷ 打鍵数」比率版は IME 予測変換/補完を測ってしまい
 * 日本語ユーザを誤検知するため依然見送り。`typing-pattern` は**タイミングベース**の旧
 * `TypingPatternAnalyzer` を framework に折り込んだもの (旧 TypingPatternCard を廃止・ADR-0009
 * の段階移行)。判定スコアゲージは持ち込まず issue ベースの advisory signal のみ。IME/支援技術を
 * 誤検知しうるため severity は notice 止まり (★6b・docs/accessibility-accommodation-policy.md)。
 */

import type { Analyzer } from '../types.js';
import { automationAnalyzer } from './automationAnalyzer.js';
import { transcriptionTopologyAnalyzer } from './transcriptionTopologyAnalyzer.js';
import { focusBurstAnalyzer } from './focusBurstAnalyzer.js';
import { pureTypingAnalyzer } from './pureTypingAnalyzer.js';
import { typingPatternAnalyzer } from './typingPatternAnalyzer.js';

export const defaultAnalyzers: readonly Analyzer[] = [
  automationAnalyzer,
  transcriptionTopologyAnalyzer,
  focusBurstAnalyzer,
  pureTypingAnalyzer,
  typingPatternAnalyzer,
];

export { automationAnalyzer } from './automationAnalyzer.js';
export { transcriptionTopologyAnalyzer } from './transcriptionTopologyAnalyzer.js';
export { focusBurstAnalyzer } from './focusBurstAnalyzer.js';
export { pureTypingAnalyzer } from './pureTypingAnalyzer.js';
export { typingPatternAnalyzer } from './typingPatternAnalyzer.js';
