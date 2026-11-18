/**
 * 教員用の一括検証で、期待と実際の出力を行ごとに並べて違う行に印を付ける (#799 / 仕様 §4.10)。DOM に触れない。
 *
 * - 同じ行番号どうしを比べる (賢い整列はしない)。行数が違えば、足りない側を「行なし」(null) とする
 * - 行の比べ方はケースの `match` に従い、`compareOutput.ts` の `normalizeOutput` で 1 行ずつ正規化して比べる
 *   - `trim`: 行末の空白は違いとしない。末尾の空行 (空白だけの行を含む) は、片側にしか無くても違いとしない
 *   - `exact`: 行の文字列と、行の後ろに改行があるかを比べる (末尾の改行の有無も違いになる)
 * - どちらの方式でも、全行が同じ ⇔ `outputsMatch` が一致 になるようにする (表の判定と食い違わない)
 *
 * CRLF は LF にそろえてから行に分ける (比較関数と同じ)。
 */

import { normalizeOutput, type OutputMatchMode } from './compareOutput.js';

/** 出力の 1 行 */
export interface OutputLine {
  /** 改行を除いた行の文字列 */
  readonly text: string;
  /** 行の後ろに改行があるか (最後の行で false なら、出力が改行で終わっていない) */
  readonly newline: boolean;
}

/** 並べた 1 行 */
export interface DiffLine {
  /** 0 始まりの行番号 */
  readonly index: number;
  /** 期待の行。期待がこの行まで無ければ null */
  readonly expected: OutputLine | null;
  /** 実際の行。実際がこの行まで無ければ null */
  readonly actual: OutputLine | null;
  /** 比べ方の上で同じか */
  readonly same: boolean;
}

/** 出力を行に分ける (最後の改行の後ろの空文字は行に数えない) */
export function splitOutputLines(text: string): OutputLine[] {
  if (text === '') return [];
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  const endsWithNewline = parts[parts.length - 1] === '';
  if (endsWithNewline) parts.pop();
  return parts.map((line, index) => ({ text: line, newline: index < parts.length - 1 || endsWithNewline }));
}

/** `trim` で、この行番号から後ろがすべて空行 (空白だけを含む) か */
function blankFrom(lines: readonly OutputLine[], index: number): boolean {
  return lines.slice(index).every((line) => normalizeOutput(line.text, 'trim') === '');
}

function sameLine(
  expected: OutputLine | null,
  actual: OutputLine | null,
  mode: OutputMatchMode,
  trailingBlank: boolean
): boolean {
  if (mode === 'trim') {
    // 末尾の空行の並びにある行は、片側が「行なし」でも違いとしない
    if (trailingBlank) return true;
    if (expected === null || actual === null) return false;
    return normalizeOutput(expected.text, 'trim') === normalizeOutput(actual.text, 'trim');
  }
  if (expected === null || actual === null) return false;
  return expected.text === actual.text && expected.newline === actual.newline;
}

/** 期待と実際を行ごとに並べる */
export function diffOutputLines(expected: string, actual: string, mode: OutputMatchMode): DiffLine[] {
  const left = splitOutputLines(expected);
  const right = splitOutputLines(actual);
  const length = Math.max(left.length, right.length);
  const lines: DiffLine[] = [];
  for (let index = 0; index < length; index++) {
    const e = left[index] ?? null;
    const a = right[index] ?? null;
    const trailingBlank = mode === 'trim' && blankFrom(left, index) && blankFrom(right, index);
    lines.push({ index, expected: e, actual: a, same: sameLine(e, a, mode, trailingBlank) });
  }
  return lines;
}
