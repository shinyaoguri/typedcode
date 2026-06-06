/**
 * 既定で公開してよい (= 開示しても evasion を大きく助けない) 分析器。
 *
 * - `automation`: 自動化ブラウザの環境 tell を見る最初の本物の分析器 (ADR-0009)。
 * - `pureTyping`: 既存 advisory (`isPureTyping`) を signal に折り込むプレースホルダ。
 *
 * 感度の高い本物の分析器 (転写トポロジー / keystroke↔content 等) は採点者側に private で
 * 足す想定。差し替え方: `runAnalysis(input, [myAnalyzer, ...defaultAnalyzers])`。
 */

import type { Analyzer } from '../types.js';
import { automationAnalyzer } from './automationAnalyzer.js';
import { pureTypingAnalyzer } from './pureTypingAnalyzer.js';

export const defaultAnalyzers: readonly Analyzer[] = [
  automationAnalyzer,
  pureTypingAnalyzer,
];

export { automationAnalyzer } from './automationAnalyzer.js';
export { pureTypingAnalyzer } from './pureTypingAnalyzer.js';
