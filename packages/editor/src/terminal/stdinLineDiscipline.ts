/**
 * ターミナルから来る生の入力を行にまとめる line discipline (#649)。
 *
 * C は Wasmer の tty がエコーと行の編集をするが、Pyodide はしない。そこで Python の stdin では、
 * ターミナル (xterm の onData) から来た文字列を 1 文字ずつここで処理して、
 * 「ターミナルにエコーする文字列」と「確定した行」に分ける。
 *
 * - 印字可能な文字 (タブを含む): 行に足してエコーする
 * - `\x7f` / `\b`: 行の最後の 1 文字を消して `\b \b` をエコーする (行が空なら何もしない)
 * - `\r` / `\n`: 改行をエコーし、`行 + "\n"` を確定する。1 回の入力の中の `\r\n` は 1 行として扱う
 *   (xterm の Enter は `\r`。CRLF の貼り付けで空行を余計に作らない)
 * - エスケープシーケンス (矢印キーなど `\x1b[A`) とそれ以外の制御文字: 捨てる (行の編集はしない)
 *
 * 貼り付けの塊 (`"3\r5\r"`) も 1 文字ずつ処理するので 2 行になる。エコーの改行は `\n` で出す
 * (ターミナルは `convertEol: true` で `\r\n` にする)。
 */

export interface LineDisciplineOutput {
  /** ターミナルにエコーする文字列 */
  echo: string;
  /** 確定した行 (末尾に `\n` を含む) */
  lines: string[];
}

const ESC = '\x1b';
const DEL = '\x7f';
const BS = '\b';

export class StdinLineDiscipline {
  /** 確定前の行 (コードポイント単位。バックスペースでサロゲートペアを半分だけ消さない) */
  private chars: string[] = [];

  /** 1 回分の入力 (xterm の onData 1 回分) を処理する */
  feed(data: string): LineDisciplineOutput {
    let echo = '';
    const lines: string[] = [];
    const input = Array.from(data);
    for (let i = 0; i < input.length; i++) {
      const ch = input[i] as string;
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && input[i + 1] === '\n') i++;
        echo += '\n';
        lines.push(`${this.chars.join('')}\n`);
        this.chars = [];
      } else if (ch === DEL || ch === BS) {
        if (this.chars.length > 0) {
          this.chars.pop();
          echo += '\b \b';
        }
      } else if (ch === ESC) {
        i = skipEscapeSequence(input, i);
      } else if (ch === '\t' || ch >= ' ') {
        this.chars.push(ch);
        echo += ch;
      }
    }
    return { echo, lines };
  }
}

/**
 * input[start] の ESC から始まるエスケープシーケンスの最後の位置を返す。
 * CSI (`ESC [ ... 終端`) と SS3 (`ESC O x`) を読み飛ばす。それ以外は ESC だけを捨てる
 */
function skipEscapeSequence(input: string[], start: number): number {
  const kind = input[start + 1];
  if (kind === 'O') return Math.min(start + 2, input.length - 1);
  if (kind !== '[') return start;
  for (let i = start + 2; i < input.length; i++) {
    const code = (input[i] as string).charCodeAt(0);
    // CSI の終端バイトは 0x40–0x7e
    if (code >= 0x40 && code <= 0x7e) return i;
  }
  return input.length - 1;
}
