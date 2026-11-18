/**
 * 期待と実際の出力の行ごとの差分 (#799)。比べ方は compareOutput.ts と食い違わないこと。
 */

import { describe, expect, it } from 'vitest';
import { outputsMatch } from '../compareOutput.js';
import { diffOutputLines, splitOutputLines } from '../outputDiff.js';

const marks = (expected: string, actual: string, mode: 'trim' | 'exact') =>
  diffOutputLines(expected, actual, mode).map((line) => (line.same ? 'same' : 'different'));

describe('splitOutputLines', () => {
  it('records whether each line ends with a newline and does not count the empty text after the last newline', () => {
    expect([splitOutputLines('a\nb\n'), splitOutputLines('a\nb'), splitOutputLines('')]).toEqual([
      [
        { text: 'a', newline: true },
        { text: 'b', newline: true },
      ],
      [
        { text: 'a', newline: true },
        { text: 'b', newline: false },
      ],
      [],
    ]);
  });

  it('treats CRLF as LF', () => {
    expect(splitOutputLines('a\r\nb\r\n')).toEqual([
      { text: 'a', newline: true },
      { text: 'b', newline: true },
    ]);
  });
});

describe('diffOutputLines', () => {
  it('marks the line whose content differs and pairs lines by line number', () => {
    const lines = diffOutputLines('3\n-2\n', '3\n0\n', 'trim');
    expect(lines.map((l) => [l.expected?.text ?? null, l.actual?.text ?? null, l.same])).toEqual([
      ['3', '3', true],
      ['-2', '0', false],
    ]);
  });

  it('with trim, trailing spaces on a line are not a difference', () => {
    expect(marks('8\n', '8  \t\n', 'trim')).toEqual(['same']);
  });

  it('with trim, extra trailing blank lines on one side are not a difference', () => {
    expect(marks('8\n', '8\n\n \n', 'trim')).toEqual(['same', 'same', 'same']);
  });

  it('with trim, a missing final newline is not a difference', () => {
    expect(marks('8\n', '8', 'trim')).toEqual(['same']);
  });

  it('with exact, trailing spaces are a difference', () => {
    expect(marks('8\n', '8 \n', 'exact')).toEqual(['different']);
  });

  it('with exact, a missing final newline is a difference', () => {
    expect(marks('8\n', '8', 'exact')).toEqual(['different']);
  });

  it('with exact, an extra trailing blank line is a difference', () => {
    expect(marks('8\n', '8\n\n', 'exact')).toEqual(['same', 'different']);
  });

  it('shows the side that runs out of lines as having no line', () => {
    const lines = diffOutputLines('1\n2\n3\n', '1\n', 'trim');
    expect(lines.map((l) => [l.expected?.text ?? null, l.actual?.text ?? null, l.same])).toEqual([
      ['1', '1', true],
      ['2', null, false],
      ['3', null, false],
    ]);
  });

  it('a blank line in the middle is still compared even with trim', () => {
    expect(marks('a\n\nb\n', 'a\nb\n', 'trim')).toEqual(['same', 'different', 'different']);
  });

  it('every line is the same exactly when the comparison function says the outputs match', () => {
    const samples: Array<[string, string]> = [
      ['8\n', '8\n'],
      ['8\n', '8'],
      ['8\n', '8 \n\n'],
      ['8\n', '9\n'],
      ['a\n \nb', 'a\n\nb'],
      ['a\n\nb\n', 'a\nb\n'],
      ['', '\n'],
      ['', ''],
      ['a\r\n', 'a\n'],
      ['a\nb\n', 'a\n'],
      ['a\n', 'a\n\nb'],
    ];
    for (const mode of ['trim', 'exact'] as const) {
      for (const [expected, actual] of samples) {
        const allSame = diffOutputLines(expected, actual, mode).every((line) => line.same);
        expect([mode, expected, actual, allSame]).toEqual([
          mode,
          expected,
          actual,
          outputsMatch(actual, expected, mode),
        ]);
      }
    }
  });
});
