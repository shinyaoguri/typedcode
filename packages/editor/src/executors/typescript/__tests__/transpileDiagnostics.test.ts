import { describe, expect, it } from 'vitest';
import { flattenMessageText, formatTranspileDiagnostics, type TranspileDiagnostic } from '../transpileDiagnostics.js';

function error(
  start: number | undefined,
  code = 1005,
  messageText: TranspileDiagnostic['messageText'] = "';' expected."
): TranspileDiagnostic {
  return { category: 1, code, start, messageText };
}

describe('flattenMessageText', () => {
  it('returns a plain string message unchanged', () => {
    expect(flattenMessageText('Expression expected.')).toBe('Expression expected.');
  });

  it('joins a nested chain with newlines and indents each level by two spaces, like ts.flattenDiagnosticMessageText', () => {
    expect(
      flattenMessageText({
        messageText: 'head',
        next: [{ messageText: 'child A', next: [{ messageText: 'grandchild' }] }, { messageText: 'child B' }],
      })
    ).toBe('head\n  child A\n    grandchild\n  child B');
  });
});

describe('formatTranspileDiagnostics', () => {
  it('reports an error on the first line with a 1-based line and column', () => {
    expect(formatTranspileDiagnostics('const x: = 1;', [error(9, 1110, 'Type expected.')])).toBe(
      '(1,10): error TS1110: Type expected.'
    );
  });

  it('counts newlines before the offset to find the line, and measures the column from the last newline', () => {
    const code = 'let a = 1;\nlet b = 2;\nlet c = ;';
    expect(formatTranspileDiagnostics(code, [error(code.indexOf(';', 24), 1109, 'Expression expected.')])).toBe(
      '(3,9): error TS1109: Expression expected.'
    );
  });

  it('breaks lines at \\n in CRLF source so the column is measured from the start of the line', () => {
    const code = 'let a = 1;\r\nlet b = ;';
    expect(formatTranspileDiagnostics(code, [error(code.lastIndexOf(';'), 1109, 'Expression expected.')])).toBe(
      '(2,9): error TS1109: Expression expected.'
    );
  });

  it('formats only error-category diagnostics and drops warnings, suggestions and messages', () => {
    const diagnostics: TranspileDiagnostic[] = [
      { category: 0, code: 6133, start: 0, messageText: 'warning' },
      error(0, 1005),
      { category: 2, code: 80001, start: 0, messageText: 'suggestion' },
      { category: 3, code: 6000, start: 0, messageText: 'message' },
    ];
    expect(formatTranspileDiagnostics('x', diagnostics)).toBe("(1,1): error TS1005: ';' expected.");
  });

  it('omits the position when a diagnostic has no start offset', () => {
    expect(formatTranspileDiagnostics('x', [error(undefined, 1005)])).toBe("error TS1005: ';' expected.");
  });

  it('flattens a chained message and joins several errors with newlines', () => {
    const code = 'a\nb';
    expect(
      formatTranspileDiagnostics(code, [
        error(0, 2322, { messageText: 'outer', next: [{ messageText: 'inner' }] }),
        error(2, 1005),
      ])
    ).toBe("(1,1): error TS2322: outer\n  inner\n(2,1): error TS1005: ';' expected.");
  });

  it('returns an empty string when there are no diagnostics', () => {
    expect(formatTranspileDiagnostics('const x = 1;', [])).toBe('');
  });
});
