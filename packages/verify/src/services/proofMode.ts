/**
 * proof の自己申告モード (ADR-0011) の入力検証。
 *
 * `ExportedProof.mode` は型の上では union だが、実体は `JSON.parse` の結果を cast した
 * だけなので実行時は任意の文字列が入りうる。攻撃者が組み立てた proof.json の値をそのまま
 * 表示層へ流すと、i18n の `t()` が未登録キーをキー文字列のまま返す性質と組み合わさって
 * 任意の文字列が innerHTML に到達する (#210)。UI へ渡す前にここで allowlist に落とす。
 *
 * `mode` は参考表示のみで保証導出には使わない (ADR-0020) ため、未知の値は捨てて
 * チップ自体を出さないのが正しい振る舞い (推測して既知の値に寄せない)。
 */

/** UI が受理する自己申告モード。shared の `ExportedProof['mode']` と同じ集合。 */
export const PROOF_MODES = ['casual', 'class', 'assignment', 'exam'] as const;

export type ProofMode = (typeof PROOF_MODES)[number];

/**
 * allowlist に一致する値だけを返す。未知の値・非文字列は `undefined` (= モードチップを出さない)。
 */
export function normalizeProofMode(value: unknown): ProofMode | undefined {
  if (typeof value !== 'string') return undefined;
  return PROOF_MODES.find((mode) => mode === value);
}
