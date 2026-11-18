/**
 * スターターコードのファイル名 → 言語 ID (Monaco / 実行 / 配布物の `starter.language`)。
 *
 * `/author` の欄 (`AuthorPage`) と教材フォルダからの書き出し (`workspace/examBundle.ts`) が
 * 同じ対応で配布物の言語を決める。shared の `getLanguageFromExtension` は対応する拡張子が
 * 広く (`.rb` → ruby など)、配布物の言語がこれまでの `/author` と変わるので使わない。
 */

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
};

/** ファイル名の最後の拡張子 (大文字小文字を区別しない) から言語 ID を返す。知らない拡張子は `plaintext`。 */
export function extensionToLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(EXTENSION_LANGUAGES, ext) ? EXTENSION_LANGUAGES[ext]! : 'plaintext';
}
