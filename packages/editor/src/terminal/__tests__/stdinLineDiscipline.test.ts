/**
 * 対話の実行の stdin の line discipline (#649 / #707)。ターミナルの生の入力を、エコーと確定した行に分け、
 * Ctrl+D (EOF) と Ctrl+C (停止) を知らせる。C / C++ / Python で共有する。
 */

import { describe, it, expect } from 'vitest';
import { StdinLineDiscipline, type LineDisciplineOutput } from '../stdinLineDiscipline.js';

/** EOF も停止も無い出力 */
function plain(echo: string, lines: string[]): LineDisciplineOutput {
  return { echo, lines, eof: false, interrupt: false };
}

describe('stdin line discipline', () => {
  it('echoes printable characters without completing a line', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('3')).toEqual(plain('3', []));
    expect(d.feed(' 5')).toEqual(plain(' 5', []));
  });

  it('completes the buffered line with a newline on Enter and echoes the newline', () => {
    const d = new StdinLineDiscipline();
    d.feed('3 5');
    expect(d.feed('\r')).toEqual(plain('\n', ['3 5\n']));
    // 確定したら行は空に戻る
    expect(d.feed('\r')).toEqual(plain('\n', ['\n']));
  });

  it('removes the last character on backspace and erases it on the terminal', () => {
    const d = new StdinLineDiscipline();
    d.feed('abc');
    expect(d.feed('\x7f')).toEqual(plain('\b \b', []));
    expect(d.feed('\b')).toEqual(plain('\b \b', []));
    expect(d.feed('\r').lines).toEqual(['a\n']);
  });

  it('ignores backspace on an empty line instead of erasing the prompt', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('\x7f')).toEqual(plain('', []));
    expect(d.feed('x\r').lines).toEqual(['x\n']);
  });

  it('splits a pasted chunk with several carriage returns into separate lines', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('3\r5\r')).toEqual(plain('3\n5\n', ['3\n', '5\n']));
  });

  it('treats CRLF in one chunk as a single line break', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('a\r\nb\r\n')).toEqual(plain('a\nb\n', ['a\n', 'b\n']));
  });

  it('removes a whole multibyte character on backspace', () => {
    const d = new StdinLineDiscipline();
    d.feed('太郎😀');
    d.feed('\x7f');
    expect(d.feed('\r').lines).toEqual(['太郎\n']);
  });

  it('drops escape sequences such as arrow keys instead of adding them to the line', () => {
    const d = new StdinLineDiscipline();
    d.feed('ab');
    expect(d.feed('\x1b[D')).toEqual(plain('', []));
    expect(d.feed('\x1bOA')).toEqual(plain('', []));
    expect(d.feed('\r').lines).toEqual(['ab\n']);
  });
});

describe('stdin line discipline: Ctrl+D and Ctrl+C (#707)', () => {
  it('signals EOF for Ctrl+D on an empty line without echoing anything', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('\x04')).toEqual({ echo: '', lines: [], eof: true, interrupt: false });
  });

  it('commits a pending line with a newline on Ctrl+D instead of signalling EOF', () => {
    const d = new StdinLineDiscipline();
    d.feed('ab');
    expect(d.feed('\x04')).toEqual(plain('\n', ['ab\n']));
    // 次の空の行の Ctrl+D で EOF
    expect(d.feed('\x04').eof).toBe(true);
  });

  it('keeps the lines committed before EOF in the same chunk and drops what follows it', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('x\r\x04ignored\r')).toEqual({ echo: 'x\n', lines: ['x\n'], eof: true, interrupt: false });
  });

  it('discards the pending line on Ctrl+C, echoes ^C and signals an interrupt', () => {
    const d = new StdinLineDiscipline();
    d.feed('12');
    expect(d.feed('\x03')).toEqual({ echo: '^C', lines: [], eof: false, interrupt: true });
    expect(d.feed('3\r').lines).toEqual(['3\n']);
  });

  it('keeps the lines committed before Ctrl+C in the same chunk and drops what follows it', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('a\rb\x03c\r')).toEqual({ echo: 'a\nb^C', lines: ['a\n'], eof: false, interrupt: true });
  });

  it('flushes the pending line with a newline once, and returns null when nothing is pending', () => {
    const d = new StdinLineDiscipline();
    expect(d.flush()).toBeNull();
    d.feed('日本');
    expect(d.flush()).toBe('日本\n');
    expect(d.flush()).toBeNull();
  });
});
