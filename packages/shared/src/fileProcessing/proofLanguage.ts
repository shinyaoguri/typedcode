/**
 * proof の自己申告言語 (`ExportedProof.language`) の入力検証。
 *
 * `language` は型の上では `string` だが、実体は `JSON.parse` の結果を cast しただけなので
 * 実行時は攻撃者が組み立てた任意の文字列が入る。これを検証せずに表示層へ流すと:
 *
 * - **verify (web)**: `ResultPanel` が `codeEl.className = \`language-${language} hljs …\`` を
 *   組み立てるため、空白区切りで既存の CSS ユーティリティクラスを足せる。
 *   `.hidden { display: none !important; }` を混ぜると `<code>` が消え、採点者からは
 *   コードプレビューが空に見える (#248)
 * - **verify-cli**: `Language:` 行に生値が出るため、改行や ANSI を仕込んで stdout を
 *   grep する運用を騙せる (#266 — 出力境界のサニタイズは別途 CLI 側で行う)
 *
 * `language` は参考表示のみで保証導出には使わない (ADR-0020) ので、既知の集合に無い値は
 * 推測して寄せず `'unknown'` に落とすのが正しい振る舞い。#210 で `mode` に敷いた
 * `normalizeProofMode` と同じ方針を `language` にも敷く。
 */

import { KNOWN_LANGUAGES } from './languageDetection.js';

/** 言語が判別できないときの表示値。表示層が従来から使ってきた既定値と同じ。 */
export const UNKNOWN_LANGUAGE = 'unknown';

/** 受理する言語 ID。`LANGUAGE_MAP` の値集合 (= エディタと出題ツールが吐きうる全て) + `'unknown'`。 */
const ACCEPTED_LANGUAGES: ReadonlySet<string> = new Set([...KNOWN_LANGUAGES, UNKNOWN_LANGUAGE]);

/**
 * allowlist に一致する値だけを返す。非文字列・集合外の値は `'unknown'`。
 *
 * 冪等なので、取り込み口と表示境界の両方で通してよい。
 */
export function normalizeProofLanguage(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_LANGUAGE;
  return ACCEPTED_LANGUAGES.has(value) ? value : UNKNOWN_LANGUAGE;
}
