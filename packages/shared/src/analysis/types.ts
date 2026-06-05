/**
 * 分析層 (ADR-0009) の契約。
 *
 * 検証 (`verifyProofFile` → `FullVerificationResult`、暗号的整合性) と **直交** する、
 * 人間らしさ / 異常度の post-hoc 分析。差し替え・追加・改良しやすいよう
 * 「`Analyzer` を差すだけ」の最小契約にしてある。**アルゴリズムの中身は後続**
 * (本ファイルはあくまで器の型定義)。
 *
 * 重要な不変条件:
 * - 分析は **判定 (pass/fail) を出さない**。出すのは手掛かり (signal) と
 *   人間レビュー優先度 (reviewPriority) のみ。最終判断は監督 / 採点者。
 * - proof には焼き込まない (後付け・再実行可能な成果物)。
 */

import type { ExportedProof } from '../types/proof.js';
import type { FullVerificationResult } from '../verification.js';

/** 分析の観点 (ADR-0009 の初期 4 次元)。新しい観点は将来ここに足す。 */
export type AnalysisDimension =
  | 'automation' // 合成入力検出
  | 'keystroke-content-consistency' // 打鍵動態 ↔ 内容の整合
  | 'transcription-topology' // 構築の形 (線形転写 vs 著述)
  | 'focus-burst-correlation'; // 離脱 ↔ バーストの相関

/** signal の重大度。`info` は要確認度に寄与しない (純粋な情報)。 */
export type AnalysisSeverity = 'info' | 'notice' | 'review';

/** 証拠: 該当 event (範囲) を指す。人間が当該箇所を検分できるよう付けることを推奨。 */
export interface EvidenceRef {
  fromEventIndex: number;
  toEventIndex?: number;
  note?: string;
}

/** 1 つの分析所見。判定ではなく「人間が見るべき手掛かり」。 */
export interface AnalysisSignal {
  analyzerId: string;
  dimension: AnalysisDimension;
  /** 異常度 0..1。 */
  score: number;
  /** 確信度 0..1。 */
  confidence: number;
  severity: AnalysisSeverity;
  /** 証拠の event 参照。空配列も可だが付けることを推奨。 */
  evidence: EvidenceRef[];
  /** 人間向けの一文サマリ。 */
  summary: string;
}

/** Analyzer への入力: 検証済み proof と暗号判定 (直交) の組。 */
export interface AnalysisInput {
  proof: ExportedProof;
  verification: FullVerificationResult;
}

/**
 * 差し替え可能な分析器。これを実装して `runAnalysis` に渡すだけで増減できる。
 *
 * - 純粋・冪等であること (同じ入力 → 同じ signal)。
 * - throw しても orchestrator が握り潰して他の分析器を止めない。
 * - 感度の高い本物の分析器は採点者側に private で足す想定 (ADR-0009)。
 */
export interface Analyzer {
  readonly id: string;
  readonly version: string;
  analyze(input: AnalysisInput): AnalysisSignal[] | Promise<AnalysisSignal[]>;
}

/** 分析レポート。判定 (pass/fail) は含めない。 */
export interface AnalysisReport {
  /** 走らせた分析器の id → version (出自記録・再現性)。 */
  analyzerVersions: Record<string, string>;
  signals: AnalysisSignal[];
  /** 0..1 の「要確認」優先度。**判定ではない**。 */
  reviewPriority: number;
}
