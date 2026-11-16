// @vitest-environment happy-dom
/**
 * 試験の許可言語をタブに当てはめる判定 (#727)。判定の規則そのもの (完全一致・starter の言語・空 = 制限なし)
 * は shared の `examLanguage.test.ts` が持つ。ここは「どのタブにどのパッケージの許可言語が掛かるか」と
 * 言語セレクタの選択肢の絞り込みを固定する。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ExamPackageManifest } from '@typedcode/shared';
import { applyLanguageOptions, createTabLanguagePolicy, type LanguagePolicyTab } from '../examLanguageGuard.js';
import type { StoredExamPackage } from '../../services/ExamPackageStore.js';

function stored(languages: string[], starterLanguage?: string): StoredExamPackage {
  return {
    manifest: { allowed: { languages } } as unknown as ExamPackageManifest,
    plaintext: '',
    ...(starterLanguage ? { starterLanguage } : {}),
  };
}

function examTab(problemId: string): LanguagePolicyTab {
  return { typingProof: { examContext: { problemId } } };
}

const plainTab: LanguagePolicyTab = { typingProof: { examContext: null } };

describe('createTabLanguagePolicy', () => {
  it('does not restrict languages outside exam mode', () => {
    const policy = createTabLanguagePolicy({ examMode: false, lookup: () => stored(['c']) });
    expect(policy.isAllowed(plainTab, 'html')).toBe(true);
  });

  it('rejects a language the exam package does not allow', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => stored(['c']) });
    expect(policy.isAllowed(examTab('p1'), 'html')).toBe(false);
  });

  it('allows every language the exam package lists', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => stored(['c', 'python']) });
    expect([policy.isAllowed(examTab('p1'), 'c'), policy.isAllowed(examTab('p1'), 'python')]).toEqual([true, true]);
  });

  it('looks up the package of the tab problem', () => {
    const packages: Record<string, StoredExamPackage> = { p1: stored(['c']), p2: stored(['python']) };
    const policy = createTabLanguagePolicy({ examMode: true, lookup: (id) => packages[id] ?? null });
    expect([policy.allowedFor(examTab('p1')), policy.allowedFor(examTab('p2'))]).toEqual([['c'], ['python']]);
  });

  it('allows the stored starter language of the problem', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => stored(['c'], 'python') });
    expect(policy.isAllowed(examTab('p1'), 'python')).toBe(true);
  });

  it('allows nothing for an exam tab whose package cannot be found', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => null });
    expect(policy.allowedFor(examTab('p1'))).toEqual([]);
  });

  it('allows nothing for an exam-mode tab without an exam context', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => stored(['c']) });
    expect(policy.isAllowed(plainTab, 'c')).toBe(false);
  });

  it('does not restrict a package that lists no languages', () => {
    const policy = createTabLanguagePolicy({ examMode: true, lookup: () => stored([]) });
    expect(policy.allowedFor(examTab('p1'))).toBeNull();
  });
});

describe('applyLanguageOptions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function selector(): HTMLSelectElement {
    document.body.innerHTML =
      '<select id="language-selector"><option value="c">C</option><option value="python">Python</option><option value="html">HTML</option></select>';
    return document.getElementById('language-selector') as HTMLSelectElement;
  }

  function blocked(sel: HTMLSelectElement): string[] {
    return Array.from(sel.options)
      .filter((o) => o.disabled && o.hidden)
      .map((o) => o.value);
  }

  it('disables and hides the options outside the allowed set', () => {
    const sel = selector();
    applyLanguageOptions(sel, ['c', 'python']);
    expect(blocked(sel)).toEqual(['html']);
  });

  it('re-enables every option when the tab is unrestricted', () => {
    const sel = selector();
    applyLanguageOptions(sel, ['c']);
    applyLanguageOptions(sel, null);
    expect(Array.from(sel.options).some((o) => o.disabled || o.hidden)).toBe(false);
  });
});
