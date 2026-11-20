/**
 * ターミナルから来る生の入力を行にまとめる line discipline (#649 / #707)。
 *
 * C / C++ / Python の対話の実行で、ターミナル (xterm の onData) から来た文字列を 1 文字ずつここで処理して、
 * 「ターミナルにエコーする文字列」と「確定した行」に分ける。プログラムには確定した行だけを渡す
 * (C も pipe の stdin で、Wasmer の tty は使わない。`CTerminal` がこの出力をエコー・記録・stdin に配る)。
 *
 * - 印字可能な文字 (タブを含む): 行に足してエコーする
 * - `\x7f` / `\b`: 行の最後の 1 文字 (コードポイント) を消して `\b \b` をエコーする (行が空なら何もしない)
 * - `\r` / `\n`: 改行をエコーし、`行 + "\n"` を確定する。1 回の入力の中の `\r\n` は 1 行として扱う
 *   (xterm の Enter は `\r`。CRLF の貼り付けで空行を余計に作らない)
 * - `\x04` (Ctrl+D): 書きかけの行があれば Enter と同じく `行 + "\n"` を確定する (EOF にはしない)。
 *   行が空なら `eof` を立て、同じ入力の残りは捨てる (#707 の決定。POSIX の端末の「LF 無しで渡す」とは違う)
 * - `\x03` (Ctrl+C): 書きかけの行を捨てて `^C` をエコーし、`interrupt` を立てる。同じ入力の残りは捨てる
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
  /** 空の行で Ctrl+D が押された (入力の終わり)。lines は EOF より前に確定した行 */
  eof: boolean;
  /** Ctrl+C が押された (実行を止める)。lines は Ctrl+C より前に確定した行 */
  interrupt: boolean;
}

const ESC = '\x1b';
const DEL = '\x7f';
const BS = '\b';
const ETX = '\x03';
const EOT = '\x04';

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
        lines.push(this.takeLine());
      } else if (ch === EOT) {
        if (this.chars.length === 0) return { echo, lines, eof: true, interrupt: false };
        echo += '\n';
        lines.push(this.takeLine());
      } else if (ch === ETX) {
        this.chars = [];
        return { echo: `${echo}^C`, lines, eof: false, interrupt: true };
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
    return { echo, lines, eof: false, interrupt: false };
  }

  /**
   * 書きかけの行を `行 + "\n"` として確定して返す (「入力終了」で閉じる前に残りを渡す。#707)。
   * 書きかけの行が無ければ null
   */
  flush(): string | null {
    return this.chars.length > 0 ? this.takeLine() : null;
  }

  private takeLine(): string {
    const line = `${this.chars.join('')}\n`;
    this.chars = [];
    return line;
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
