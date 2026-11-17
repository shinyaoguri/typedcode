/**
 * 試験の許可言語の判定 (#727)。editor の各境界と grader の照合が共有する純関数。
 */

import { describe, expect, it } from 'vitest';
import { checkExamLanguage, examAllowedLanguages, isExamLanguageAllowed } from '../index.js';

describe('examAllowedLanguages', () => {
  it('returns the manifest languages unchanged when there is no starter', () => {
    expect(examAllowedLanguages(['c', 'python'])).toEqual(['c', 'python']);
  });

  it('adds the starter language when the manifest does not list it', () => {
    expect(examAllowedLanguages(['c'], 'python')).toEqual(['c', 'python']);
  });

  it('does not duplicate a starter language the manifest already lists', () => {
    expect(examAllowedLanguages(['c', 'python'], 'c')).toEqual(['c', 'python']);
  });

  it('treats an empty manifest list as unrestricted even when a starter exists', () => {
    expect(examAllowedLanguages([], 'c')).toBeNull();
  });
});

describe('isExamLanguageAllowed', () => {
  it('allows a language that is in the set', () => {
    expect(isExamLanguageAllowed(['c', 'python'], 'python')).toBe(true);
  });

  it('rejects a language that is not in the set', () => {
    expect(isExamLanguageAllowed(['c'], 'html')).toBe(false);
  });

  it('compares names exactly without folding case or whitespace', () => {
    expect([isExamLanguageAllowed(['c'], 'C'), isExamLanguageAllowed(['c'], ' c')]).toEqual([false, false]);
  });

  it('rejects a non-string language', () => {
    expect(isExamLanguageAllowed(['c'], 42)).toBe(false);
  });

  it('allows any language when unrestricted', () => {
    expect(isExamLanguageAllowed(null, 'html')).toBe(true);
  });

  it('allows nothing for an empty set', () => {
    expect(isExamLanguageAllowed([], 'c')).toBe(false);
  });
});

describe('checkExamLanguage', () => {
  it('reports allowed for an allowed proof language', () => {
    expect(checkExamLanguage(['c'], 'c')).toEqual({ status: 'allowed' });
  });

  it('reports not-allowed with a reason for a language outside the set', () => {
    expect(checkExamLanguage(['c'], 'html')).toEqual({
      status: 'not-allowed',
      reason: "Proof language is not one of the exam package's allowed languages",
    });
  });

  it('reports not-allowed with a missing-language reason when the proof carries no language string', () => {
    expect(checkExamLanguage(['c'], undefined)).toEqual({
      status: 'not-allowed',
      reason: 'Proof has no language to check against the allowed languages',
    });
  });

  it('reports not-evaluated when the package is unrestricted', () => {
    expect(checkExamLanguage(null, 'html').status).toBe('not-evaluated');
  });
});
