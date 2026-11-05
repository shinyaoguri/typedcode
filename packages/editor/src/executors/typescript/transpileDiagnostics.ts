/**
 * Monaco 同梱の TypeScript worker が返す診断を、ターミナルに出す文字列へ整形する純関数 (#605)
 *
 * 形式は以前の `ts.transpileModule` + `ts.flattenDiagnosticMessageText` と同じ
 * (`(行,列): error TS<code>: <message>`)。`TypeScriptExecutor.parseErrors` がこの形を読んで
 * エディタにマーカーを付けるので、形を変えるときは両方を揃える。
 * monaco を import しない (node のユニットテストで読めるように、必要な部分だけ型を自前で持つ)。
 */

/** Monaco の `DiagnosticMessageChain` のうち整形に使う部分 */
export interface TranspileDiagnosticMessageChain {
  messageText: string;
  next?: TranspileDiagnosticMessageChain[];
}

/** Monaco の `Diagnostic` のうち整形に使う部分 (category: warning = 0, error = 1, suggestion = 2, message = 3) */
export interface TranspileDiagnostic {
  category: 0 | 1 | 2 | 3;
  code: number;
  /** ファイル先頭からの offset (UTF-16 単位) */
  start: number | undefined;
  messageText: string | TranspileDiagnosticMessageChain;
}

const ERROR_CATEGORY = 1;

/**
 * `ts.flattenDiagnosticMessageText(messageText, '\n')` と同じ平坦化。
 * chain の子は `\n` で区切り、深さごとに 2 空白ずつインデントする。
 */
export function flattenMessageText(messageText: string | TranspileDiagnosticMessageChain): string {
  if (typeof messageText === 'string') return messageText;
  return flattenChain(messageText, 0);
}

function flattenChain(chain: TranspileDiagnosticMessageChain, indent: number): string {
  let result = '';
  if (indent > 0) {
    result += '\n' + '  '.repeat(indent);
  }
  result += chain.messageText;
  indent++;
  for (const child of chain.next ?? []) {
    result += flattenChain(child, indent);
  }
  return result;
}

/** offset を 1 始まりの行・列にする。行は `\n` で切る (CRLF の `\r` は直前の行の末尾に残る) */
function lineAndColumnOf(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, code.length);
  for (let i = 0; i < end; i++) {
    if (code.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * error (category 1) の診断だけを、1 件 1 行で `\n` 連結する。error が無ければ空文字。
 * start があれば `(行,列): error TS<code>: <message>`、無ければ `error TS<code>: <message>`。
 */
export function formatTranspileDiagnostics(code: string, diagnostics: readonly TranspileDiagnostic[]): string {
  return diagnostics
    .filter((d) => d.category === ERROR_CATEGORY)
    .map((d) => {
      const message = flattenMessageText(d.messageText);
      if (d.start !== undefined) {
        const { line, column } = lineAndColumnOf(code, d.start);
        return `(${line},${column}): error TS${d.code}: ${message}`;
      }
      return `error TS${d.code}: ${message}`;
    })
    .join('\n');
}
