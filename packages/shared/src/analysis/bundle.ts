/**
 * Tier A 分析バンドル (ADR-0024 のデータ最小化ティア)。
 *
 * 「**content-free な派生ビュー**」= 整合性検証用の full proof (Tier F) から、ソース全文・
 * 各イベントの打鍵文字・fingerprint を**落とした**上で、分析・研究・コホート集計に必要な
 * 派生物だけを束ねたもの:
 *   - `ProcessSummary` (Phase 8 W3) — 過程の中立な記述 (event index + 数値メトリクス)
 *   - `AnalysisReport` (ADR-0009) — advisory な手掛かり
 *   - `AssuranceResult` (ADR-0020) — 三層保証 (整合性/時刻/著述性)
 *
 * 不変条件 (ADR-0024):
 * - バンドルは proof を**改変しない**派生物。events / content / fingerprint を含まない。
 * - **単独では整合性検証できない** (Tier F で別途検証される)。`integrityValid` はその
 *   「派生元 proof が検証されたか」の注記であって、このバンドル自体の検証ではない。
 * - `ProcessSummary.reflectionNotes` は学生が採点者向けに書いた自己申告で、ソースとは別の
 *   感度クラス (ADR-0024 §4 で Tier A に含めてよいと決定済み)。コホート集計 (ADR-0025) は使わない。
 *
 * `AnalysisBundle[]` は ADR-0025 のコホート基準 (`computeCohortBaseline`) の入力フォーマット。
 *
 * **Tier A は学外・研究者へそのまま渡すものではない** (#304): 参照をそのまま束ねるので、
 * `reflectionNotes`・signal の `summary` / `summaryParams` / `evidence.note`・外部 analyzer が
 * 決める `analyzerId` / `dimension`、さらに型に無い余分なフィールドも素通しする (verify-cli は
 * さらに `filename` を足す)。集計・研究用は `aggregateBundle.ts` の Tier S (allowlist) を使う。
 */

import type { ProcessSummary } from '../processSummary.js';
import type { AssuranceResult } from '../assurance.js';
import type { AnalysisReport } from './types.js';

/** Tier A バンドルの schema 識別子 (将来の互換判定用)。 */
export const ANALYSIS_BUNDLE_SCHEMA = 'analysis-bundle/1' as const;

/**
 * 派生ビュー (Tier A / Tier S) に必ず載せる固定文言 (ADR-0024 不変条件 6、#304)。
 *
 * バンドルは単独で整合性を検証できないことを、ファイルを受け取った人にも見える形で示す
 * (overclaim 防止)。文言は固定で、proof 由来の値を補間しない。
 */
export const DERIVED_VIEW_NOTICE =
  'Derived advisory view (ADR-0024): not independently verifiable. Integrity is verified only on the full proof (Tier F).' as const;

/** content-free な Tier A 分析バンドル (ADR-0024)。 */
export interface AnalysisBundle {
  schema: typeof ANALYSIS_BUNDLE_SCHEMA;
  /** 派生ビューで単独では検証できない旨の固定文言 (#304。追記のみなので schema は据え置き)。 */
  notice: typeof DERIVED_VIEW_NOTICE;
  /**
   * 派生元 proof が整合性検証を通ったか (Tier F での検証結果の注記)。
   * **このバンドル自体の検証ではない** — バンドルは単独で整合性検証できない (ADR-0024)。
   */
  integrityValid: boolean;
  processSummary: ProcessSummary;
  analysis: AnalysisReport;
  assurance: AssuranceResult;
}

/**
 * content-free な派生物から Tier A バンドルを組み立てる (純粋・決定的)。
 *
 * 入力はすべて既に proof から導出済みの content-free な派生物であること。本関数は
 * full proof (events/content/fingerprint) を**受け取らない** — 取り違えで生データが
 * 紛れ込むのを型で防ぐ。
 */
export function buildAnalysisBundle(input: {
  integrityValid: boolean;
  processSummary: ProcessSummary;
  analysis: AnalysisReport;
  assurance: AssuranceResult;
}): AnalysisBundle {
  return {
    schema: ANALYSIS_BUNDLE_SCHEMA,
    notice: DERIVED_VIEW_NOTICE,
    integrityValid: input.integrityValid,
    processSummary: input.processSummary,
    analysis: input.analysis,
    assurance: input.assurance,
  };
}
