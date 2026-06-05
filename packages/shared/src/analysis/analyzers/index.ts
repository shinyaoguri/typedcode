/**
 * 既定で公開してよい (= 開示しても evasion を大きく助けない) サンプル分析器。
 *
 * いずれも **方向性を示すプレースホルダ** であり、実用的な判定ロジックではない
 * (ADR-0009)。感度の高い本物の分析器は採点者側に private で足す想定。
 * 差し替え方: `runAnalysis(input, [myAnalyzer, ...defaultAnalyzers])`。
 */

import type { Analyzer } from '../types.js';
import { largestGapAnalyzer } from './largestGapAnalyzer.js';
import { pureTypingAnalyzer } from './pureTypingAnalyzer.js';

export const defaultAnalyzers: readonly Analyzer[] = [
  largestGapAnalyzer,
  pureTypingAnalyzer,
];

export { largestGapAnalyzer } from './largestGapAnalyzer.js';
export { pureTypingAnalyzer } from './pureTypingAnalyzer.js';
