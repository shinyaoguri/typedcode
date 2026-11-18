/**
 * 教員用の一括検証で、実際の出力と期待の出力を比べる (#802 / ADR-0051 Decision 6 / 仕様 §4.10)。
 *
 * 両方の CRLF を LF にしてから比べる。単独の `\r` は改行として扱わない (CRLF だけを LF にする)。
 * - `trim` (既定): 各行の末尾の空白 (スペース・タブ) と、末尾の空行を取り除いて完全一致
 * - `exact`: CRLF → LF の後はそのまま完全一致
 *
 * 行頭の空白・途中の空行の違いはどちらでも不一致。受講者側の判定には使わない (§4.9 / ADR-0048)。
 */

/** 比べ方。ケースファイルの `match` (省略時は `trim`) */
export type OutputMatchMode = 'trim' | 'exact';

/** 省略時の比べ方 */
export const DEFAULT_OUTPUT_MATCH_MODE: OutputMatchMode = 'trim';

/** 比べる前の形にする (比べ方ごとに、無視する違いを落とした文字列) */
export function normalizeOutput(text: string, mode: OutputMatchMode): string {
  const lf = text.replace(/\r\n/g, '\n');
  if (mode === 'exact') return lf;
  const lines = lf.split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** 実際の出力が期待と一致するか */
export function outputsMatch(
  actual: string,
  expected: string,
  mode: OutputMatchMode = DEFAULT_OUTPUT_MATCH_MODE
): boolean {
  return normalizeOutput(actual, mode) === normalizeOutput(expected, mode);
}
