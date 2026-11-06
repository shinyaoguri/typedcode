/**
 * Python の stdin の line discipline (#649)。ターミナルの生の入力を、エコーと確定した行に分ける。
 */

import { describe, it, expect } from 'vitest';
import { StdinLineDiscipline } from '../stdinLineDiscipline.js';

describe('stdin line discipline', () => {
  it('echoes printable characters without completing a line', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('3')).toEqual({ echo: '3', lines: [] });
    expect(d.feed(' 5')).toEqual({ echo: ' 5', lines: [] });
  });

  it('completes the buffered line with a newline on Enter and echoes the newline', () => {
    const d = new StdinLineDiscipline();
    d.feed('3 5');
    expect(d.feed('\r')).toEqual({ echo: '\n', lines: ['3 5\n'] });
    // 確定したら行は空に戻る
    expect(d.feed('\r')).toEqual({ echo: '\n', lines: ['\n'] });
  });

  it('removes the last character on backspace and erases it on the terminal', () => {
    const d = new StdinLineDiscipline();
    d.feed('abc');
    expect(d.feed('\x7f')).toEqual({ echo: '\b \b', lines: [] });
    expect(d.feed('\b')).toEqual({ echo: '\b \b', lines: [] });
    expect(d.feed('\r').lines).toEqual(['a\n']);
  });

  it('ignores backspace on an empty line instead of erasing the prompt', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('\x7f')).toEqual({ echo: '', lines: [] });
    expect(d.feed('x\r').lines).toEqual(['x\n']);
  });

  it('splits a pasted chunk with several carriage returns into separate lines', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('3\r5\r')).toEqual({ echo: '3\n5\n', lines: ['3\n', '5\n'] });
  });

  it('treats CRLF in one chunk as a single line break', () => {
    const d = new StdinLineDiscipline();
    expect(d.feed('a\r\nb\r\n')).toEqual({ echo: 'a\nb\n', lines: ['a\n', 'b\n'] });
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
    expect(d.feed('\x1b[D')).toEqual({ echo: '', lines: [] });
    expect(d.feed('\x1bOA')).toEqual({ echo: '', lines: [] });
    expect(d.feed('\r').lines).toEqual(['ab\n']);
  });
});
