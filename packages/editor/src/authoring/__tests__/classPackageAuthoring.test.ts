import { describe, expect, it } from 'vitest';
import { parseClassPackage, type ExamBundleProblem } from '@typedcode/shared';
import { buildClassPackage } from '../classPackageAuthoring.js';

function sampleProblems(): ExamBundleProblem[] {
  return [
    { problemId: 'p1', statement: '# 問題1\n和を出力せよ。', starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' } },
    { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
  ];
}

describe('buildClassPackage', () => {
  it('emits a .tcclass that shared parseClassPackage round-trips', () => {
    const out = buildClassPackage({ classId: 'algo-w3', problems: sampleProblems(), languages: ['c'] });
    const parsed = parseClassPackage(JSON.parse(out));
    expect(parsed).not.toBeNull();
    expect(parsed!.classId).toBe('algo-w3');
    expect(parsed!.allowed.languages).toEqual(['c']);
    expect(parsed!.bundle.problems).toHaveLength(2);
    expect(parsed!.bundle.problems[0]!.starter?.filename).toBe('p1.c');
  });

  it('rejects a missing classId', () => {
    expect(() => buildClassPackage({ classId: '  ', problems: sampleProblems(), languages: ['c'] })).toThrow();
  });

  it('rejects an empty problem list', () => {
    expect(() => buildClassPackage({ classId: 'x', problems: [], languages: ['c'] })).toThrow();
  });

  it('rejects duplicate problemIds', () => {
    const dup = [
      { problemId: 'p1', statement: 'a' },
      { problemId: 'p1', statement: 'b' },
    ];
    expect(() => buildClassPackage({ classId: 'x', problems: dup, languages: ['c'] })).toThrow();
  });

  it('rejects an empty statement', () => {
    expect(() => buildClassPackage({ classId: 'x', problems: [{ problemId: 'p1', statement: '   ' }], languages: ['c'] })).toThrow();
  });

  it('rejects when no languages are allowed', () => {
    expect(() => buildClassPackage({ classId: 'x', problems: sampleProblems(), languages: [] })).toThrow();
  });
});
