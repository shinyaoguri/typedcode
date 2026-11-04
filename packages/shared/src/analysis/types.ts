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
  /** 人間向けの一文サマリ (フォールバック / 非ローカライズ環境用)。 */
  summary: string;
  /**
   * ローカライズ用の翻訳キー (任意)。表示側が summaryKey を解決できれば summary より優先する。
   * shared は i18n を持たないため、文言の最終形は消費側 (verify/CLI) が決める。
   */
  summaryKey?: string;
  /** summaryKey の補間パラメータ。 */
  summaryParams?: Record<string, string | number>;
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
 * - throw (同期・非同期とも)・期限切れ (`ANALYZER_TIMEOUT_MS`)・契約に合わない出力は、
 *   orchestrator がその分析器の `analyzerStatus` に記録し、他の分析器を止めない (#301)。
 *   失敗は signal にしない (「手掛かりなし」と区別するため)。
 * - 期限は非同期の待ちにしか効かない。**同期の無限ループは止まらない** — 外部分析器は信頼済みの
 *   コードとして扱う前提 (ADR-0009)。
 * - 感度の高い本物の分析器は採点者側に private で足す想定 (ADR-0009)。
 */
export interface Analyzer {
  readonly id: string;
  readonly version: string;
  analyze(input: AnalysisInput): AnalysisSignal[] | Promise<AnalysisSignal[]>;
}

/**
 * 分析器 1 つの実行結果の状態 (#301)。
 *
 * - `ok`: 契約どおりの出力を返した (signal 0 件を含む = 「手掛かりなし」)
 * - `failed`: 同期・非同期に throw した
 * - `timeout`: 期限 (`ANALYZER_TIMEOUT_MS`) までに決着しなかった。後から解決しても結果は捨てる
 * - `invalid-output`: 戻り値が配列でない、または契約に合わない signal を含んでいた
 *   (合わない signal だけを捨て、合う signal は残す)
 */
export type AnalyzerRunStatus = 'ok' | 'failed' | 'timeout' | 'invalid-output';

/** `AnalysisReport.analyzerStatus` の 1 要素。 */
export interface AnalyzerStatus {
  version: string;
  status: AnalyzerRunStatus;
  /**
   * 人間向けの補足 (例外のメッセージなど)。外部分析器が決められる**未信頼の文字列**で、
   * orchestrator が長さを切ってある。表示側は CLI なら `safe()`、Web なら `escapeHtml` を通すこと。
   */
  message?: string;
  /** `invalid-output` のとき、捨てた signal の数。 */
  discardedSignals?: number;
}

/** 分析レポート。判定 (pass/fail) は含めない。 */
export interface AnalysisReport {
  /** 走らせた分析器の id → version (出自記録・再現性)。互換のため残す (正本は `analyzerStatus`)。 */
  analyzerVersions: Record<string, string>;
  /**
   * 走らせた分析器の id → 実行結果の状態 (#301)。`ok` の分析器が 1 つも無ければ、signal 0 件は
   * 「手掛かりなし」ではなく「分析できなかった」を意味する。
   *
   * このフィールドより前に書かれた JSON (`--analysis-json` / `analysis-bundle/1` の旧出力) には無い。
   * 読み手は**無ければ「分析できたか不明」として扱い**、正常なゼロ signal と見なさないこと。
   */
  analyzerStatus: Record<string, AnalyzerStatus>;
  signals: AnalysisSignal[];
  /** 0..1 の「要確認」優先度。**判定ではない**。 */
  reviewPriority: number;
}
