/**
 * 既定で公開してよい (= 開示しても evasion を大きく助けない) 分析器。
 *
 * ADR-0009 の次元の第一次ヒューリスティック + 既存 advisory の折り込み:
 * - `automation`             : 自動化ブラウザの環境 tell (webdriver / 自動化グローバル / headless renderer)
 * - `transcription-topology` : 修正 (削除) の少なさ
 * - `focus-burst`            : 長い離脱 → 復帰直後の大量入力
 * - `pureTyping`             : 既存 `isPureTyping` advisory の折り込み
 *
 * いずれも **第一次ヒューリスティックで低 confidence・advisory のみ**。感度の高い本物の分析器
 * (重み/閾値を秘匿したいもの) は採点者側に private で足す想定。
 * 差し替え方: `runAnalysis(input, [myAnalyzer, ...defaultAnalyzers])`。
 *
 * NOTE: keystroke↔content 整合は「挿入文字数 ÷ 打鍵数」の比率では IME 予測変換/補完を
 * 測ってしまい日本語ユーザを誤検知するため見送り。タイミング/合成構造ベースの本格版を別途設計する。
 */

import type { Analyzer } from '../types.js';
import { automationAnalyzer } from './automationAnalyzer.js';
import { transcriptionTopologyAnalyzer } from './transcriptionTopologyAnalyzer.js';
import { focusBurstAnalyzer } from './focusBurstAnalyzer.js';
import { pureTypingAnalyzer } from './pureTypingAnalyzer.js';

export const defaultAnalyzers: readonly Analyzer[] = [
  automationAnalyzer,
  transcriptionTopologyAnalyzer,
  focusBurstAnalyzer,
  pureTypingAnalyzer,
];

export { automationAnalyzer } from './automationAnalyzer.js';
export { transcriptionTopologyAnalyzer } from './transcriptionTopologyAnalyzer.js';
export { focusBurstAnalyzer } from './focusBurstAnalyzer.js';
export { pureTypingAnalyzer } from './pureTypingAnalyzer.js';
