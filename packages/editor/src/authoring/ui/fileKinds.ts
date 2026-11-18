/**
 * 作問画面で開くファイルの種類 (#796)。
 *
 * Monaco の言語 ID は拡張子から決める。配布物の `starter.language` と実行の言語は `starterLanguage.ts` が
 * 正本で、ここはその対応に Markdown と YAML を足しただけ (表示用。配布物の言語を決めるのには使わない)。
 */

import { extensionToLanguage } from '../starterLanguage.js';
import { workspaceBasename } from '../workspace/paths.js';

function extensionOf(path: string): string {
  const name = workspaceBasename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Monaco の言語 ID (`markdown` / `yaml` / `c` / `cpp` / `python` / `javascript` / `typescript` / `plaintext`) */
export function monacoLanguageFor(path: string): string {
  const ext = extensionOf(path);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return extensionToLanguage(workspaceBasename(path));
}

export function isMarkdownPath(path: string): boolean {
  return monacoLanguageFor(path) === 'markdown';
}

/** 実行の言語 (実行できない拡張子は `plaintext` などになり、実行系が「実行できない」と知らせる) */
export function runLanguageFor(path: string): string {
  return extensionToLanguage(workspaceBasename(path));
}

/** 拡張子 (`.c` の形。無ければ空文字) */
export function dottedExtension(path: string): string {
  const name = workspaceBasename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
