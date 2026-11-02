import { describe, expect, it } from 'vitest';
import { resolveMarkerRange, type LineBoundedModel } from '../errorMarkerRange.js';

/** 行ごとの文字数から、Monaco と同じく範囲外の行で例外を投げるモデルを作る */
function modelOf(...lineLengths: number[]): LineBoundedModel {
  return {
    getLineCount: () => lineLengths.length,
    getLineMaxColumn: (lineNumber) => {
      const length = lineLengths[lineNumber - 1];
      if (length === undefined) throw new Error('Illegal value for lineNumber');
      return length + 1;
    },
  };
}

describe('resolveMarkerRange', () => {
  it('keeps an in-range error on its own line, up to the end of that line', () => {
    expect(resolveMarkerRange(modelOf(10, 20, 5), { line: 2, column: 4 })).toEqual({
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 21,
    });
  });

  it('moves a line beyond the end of the model to the last line instead of throwing', () => {
    expect(resolveMarkerRange(modelOf(30), { line: 7, column: 19 })).toEqual({
      startLineNumber: 1,
      startColumn: 19,
      endLineNumber: 1,
      endColumn: 31,
    });
    expect(resolveMarkerRange(modelOf(3, 8), { line: 99, column: 1 }).startLineNumber).toBe(2);
  });

  it('moves a line below 1 to the first line instead of throwing', () => {
    expect(resolveMarkerRange(modelOf(3, 8), { line: 0, column: 1 }).startLineNumber).toBe(1);
    expect(resolveMarkerRange(modelOf(3, 8), { line: -4, column: 1 }).startLineNumber).toBe(1);
  });

  it('keeps the start column inside the line after the line was moved', () => {
    const range = resolveMarkerRange(modelOf(2), { line: 9, column: 40 });

    expect(range.startColumn).toBe(range.endColumn);
  });
});
