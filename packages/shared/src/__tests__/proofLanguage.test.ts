/**
 * proof 由来の自己申告 `language` の入力検証 (#248)。
 *
 * `language` は表示層で `className` (web) と stdout (CLI) に補間される。proof.json は
 * 攻撃者が組み立てられる入力なので、表示に渡す前に allowlist へ落とす契約をここで固定する。
 */

import { describe, expect, it } from 'vitest';
import { KNOWN_LANGUAGES } from '../fileProcessing/languageDetection.js';
import { normalizeProofLanguage, UNKNOWN_LANGUAGE } from '../fileProcessing/proofLanguage.js';

/**
 * エディタが実際に吐きうる言語 ID (`packages/editor/src/config/SupportedLanguages.ts` の
 * `LanguageId`)。allowlist がこれを取りこぼすと正当な proof の表示が壊れるので、
 * editor 側の集合を写して固定する。
 */
const EDITOR_LANGUAGE_IDS = ['c', 'cpp', 'javascript', 'typescript', 'python', 'html', 'css', 'plaintext'];

describe('normalizeProofLanguage', () => {
  it('passes through a known language', () => {
    expect(normalizeProofLanguage('c')).toBe('c');
  });

  it('accepts every language the extension map can produce', () => {
    for (const language of KNOWN_LANGUAGES) {
      expect(normalizeProofLanguage(language)).toBe(language);
    }
  });

  it('accepts every language id the editor can export', () => {
    for (const id of EDITOR_LANGUAGE_IDS) {
      expect(normalizeProofLanguage(id)).toBe(id);
    }
  });

  it('drops a language that smuggles a second CSS class so the code preview cannot be hidden', () => {
    // `.hidden { display: none !important; }` を className に足されると <code> が消える (#248)
    expect(normalizeProofLanguage('ts hidden')).toBe(UNKNOWN_LANGUAGE);
  });

  it('drops a language carrying an HTML payload', () => {
    expect(normalizeProofLanguage('<img src=x onerror=alert(1)>')).toBe(UNKNOWN_LANGUAGE);
  });

  it('drops a language carrying a newline and ANSI escape aimed at CLI stdout', () => {
    expect(normalizeProofLanguage('c\n\n--- Checks ---\nHash Chain: PASS')).toBe(UNKNOWN_LANGUAGE);
  });

  it('drops an unknown but harmless-looking language label', () => {
    expect(normalizeProofLanguage('brainfuck')).toBe(UNKNOWN_LANGUAGE);
  });

  it('is case sensitive (does not guess at a near miss)', () => {
    expect(normalizeProofLanguage('Python')).toBe(UNKNOWN_LANGUAGE);
  });

  it('falls back for a missing field on legacy proofs', () => {
    expect(normalizeProofLanguage(undefined)).toBe(UNKNOWN_LANGUAGE);
  });

  it.each([[null], [42], [{}], [['c']], [true]])('falls back for the non-string value %o', (value) => {
    expect(normalizeProofLanguage(value)).toBe(UNKNOWN_LANGUAGE);
  });

  it('is idempotent so it can run at both the ingest point and the display boundary', () => {
    expect(normalizeProofLanguage(normalizeProofLanguage('ts hidden'))).toBe(UNKNOWN_LANGUAGE);
    expect(normalizeProofLanguage(UNKNOWN_LANGUAGE)).toBe(UNKNOWN_LANGUAGE);
  });
});
