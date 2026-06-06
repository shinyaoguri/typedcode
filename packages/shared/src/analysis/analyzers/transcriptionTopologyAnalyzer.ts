/**
 * transcription-topology 分析器 (ADR-0009)。
 *
 * [第一次ヒューリスティック] 修正 (削除) が極端に少なくないかを見る。
 *
 * 原文を著述するときは試行錯誤で削除が混じる。外部ソースを見ながら打ち直す「転写」は
 * 削除がほぼ出ない傾向がある。content イベントに占める削除系 inputType の比率が極端に低い
 * 場合に弱い手掛かりを出す。慎重で手戻りの少ない人も低くなり得るため confidence は低い。
 * 本格的な構築トポロジー分析 (rangeOffset の前後跳躍・挿入順序の形) は後続。
 *
 * 出力は advisory のみ — 判定はしない。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer } from '../types.js';

const ID = 'transcription-topology';
/** これ未満の編集数では試料が小さすぎるので判定しない。 */
const MIN_CONTENT_EVENTS = 100;
/** 削除比率がこれ未満なら「修正がほぼ無い」とみなす。 */
const LOW_REVISION_RATIO = 0.02;

export const transcriptionTopologyAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const content = input.proof.proof.events.filter((e) => e.type === 'contentChange');
    if (content.length < MIN_CONTENT_EVENTS) return [];

    const deletions = content.filter((e) => e.inputType?.startsWith('delete') ?? false).length;
    const revisionRatio = deletions / content.length;
    if (revisionRatio >= LOW_REVISION_RATIO) return [];

    return [
      {
        analyzerId: ID,
        dimension: 'transcription-topology',
        score: 0.4,
        confidence: 0.3,
        severity: 'notice',
        evidence: [],
        summary: `Very low revision rate (${(revisionRatio * 100).toFixed(1)}% deletions over ${content.length} edits): transcription-like`,
      },
    ];
  },
};
