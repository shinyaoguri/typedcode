/**
 * JS の実行時エラーからエディタのマーカーを作る経路のテスト。
 *
 * 出力の `(at line N, column M)` はユーザーコードの行・列に直してあり、parseErrors はそれを
 * そのまま読む。以前は正規表現がこの形に一致せずマーカーが付かず、行も前置きの分だけずれていた。
 */

import { describe, it, expect } from 'vitest';
import { parseJavaScriptErrors } from '../JavaScriptExecutor.js';

describe('parseJavaScriptErrors', () => {
  it('turns the executor error line into a marker at the reported user line and column', () => {
    expect(
      parseJavaScriptErrors("TypeError: Cannot read properties of null (reading 'x') (at line 2, column 6)\n")
    ).toEqual([
      { line: 2, column: 6, severity: 'error', message: "TypeError: Cannot read properties of null (reading 'x')" },
    ]);
  });

  it('finds the error line even when other stderr output precedes it in the same chunk', () => {
    const errors = parseJavaScriptErrors('[ERROR] something\nReferenceError: y is not defined (at line 7, column 1)\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 7, column: 1, message: 'ReferenceError: y is not defined' });
  });

  it('does not create a marker from output without an executor location', () => {
    expect(parseJavaScriptErrors('[ERROR] at foo (<anonymous>:3:5)\n')).toEqual([]);
  });
});
