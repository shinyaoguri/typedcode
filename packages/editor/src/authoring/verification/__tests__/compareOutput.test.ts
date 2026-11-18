/**
 * 一括検証の出力の比べ方 (#802 / 仕様 §4.10)。純関数なので実体をそのまま使う。
 */

import { describe, it, expect } from 'vitest';
import { outputsMatch, type OutputMatchMode } from '../compareOutput.js';

const MODES: OutputMatchMode[] = ['trim', 'exact'];

describe('outputsMatch (trim)', () => {
  it('treats CRLF and LF line endings as the same output', () => {
    expect(outputsMatch('1\r\n2\r\n', '1\n2\n', 'trim')).toBe(true);
  });

  it('ignores spaces and tabs at the end of each line', () => {
    expect(outputsMatch('1 \t\n2  \n', '1\n2\n', 'trim')).toBe(true);
  });

  it('ignores whether trailing blank lines are present', () => {
    expect(outputsMatch('8', '8\n\n\n', 'trim')).toBe(true);
  });

  it('is the default mode when no mode is given', () => {
    expect(outputsMatch('8  \n', '8')).toBe(true);
  });
});

describe('outputsMatch (exact)', () => {
  it('treats CRLF and LF line endings as the same output', () => {
    expect(outputsMatch('1\r\n2\r\n', '1\n2\n', 'exact')).toBe(true);
  });

  it('reports trailing spaces at the end of a line as a mismatch', () => {
    expect(outputsMatch('1 \n', '1\n', 'exact')).toBe(false);
  });

  it('reports a missing trailing newline as a mismatch', () => {
    expect(outputsMatch('8', '8\n', 'exact')).toBe(false);
  });
});

describe.each(MODES)('outputsMatch (%s) in both modes', (mode) => {
  it('reports different leading whitespace as a mismatch', () => {
    expect(outputsMatch(' 8\n', '8\n', mode)).toBe(false);
  });

  it('reports a different blank line in the middle as a mismatch', () => {
    expect(outputsMatch('1\n\n2\n', '1\n2\n', mode)).toBe(false);
  });

  it('does not treat a lone carriage return as a line break', () => {
    expect(outputsMatch('1\r2\n', '1\n2\n', mode)).toBe(false);
  });

  it('matches identical output', () => {
    expect(outputsMatch('-2\n', '-2\n', mode)).toBe(true);
  });
});
