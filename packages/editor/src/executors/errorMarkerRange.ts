/**
 * コンパイルエラーをエディタのマーカーにするときの範囲の正規化。
 *
 * clang が返す行番号は、モデルより長い (preamble の分ずれる等) こともあれば 0 以下のこともある。
 * Monaco の `getLineMaxColumn` は範囲外の行で `Illegal value for lineNumber` を投げ、
 * マーカーが一つも付かなくなるので、範囲外の行は捨てずに最終行 (1 未満なら 1 行目) へ寄せて
 * 利用者に見える形で残す (#489)。
 */

/** `ITextModel` のうち範囲の正規化に使う部分 (テストで偽物を渡せるようにする) */
export interface LineBoundedModel {
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
}

export interface MarkerRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function resolveMarkerRange(model: LineBoundedModel, error: { line: number; column: number }): MarkerRange {
  const lineCount = Math.max(1, model.getLineCount());
  const line = Number.isFinite(error.line) ? Math.min(Math.max(Math.trunc(error.line), 1), lineCount) : 1;
  const endColumn = model.getLineMaxColumn(line);
  const startColumn = Number.isFinite(error.column) ? Math.min(Math.max(Math.trunc(error.column), 1), endColumn) : 1;
  return { startLineNumber: line, startColumn, endLineNumber: line, endColumn };
}
