import { describe, expect, it } from 'vitest';
import { EXAM_BUNDLE_SCHEMA, CLASS_PACKAGE_SCHEMA, parseClassPackage, encodeClassPackage } from '../exam/index.js';
import type { ClassPackage } from '../types/exam.js';

function samplePackage(): ClassPackage {
  return {
    schema: CLASS_PACKAGE_SCHEMA,
    classId: '2026-algo-week3',
    allowed: { languages: ['c', 'python'] },
    bundle: {
      schema: EXAM_BUNDLE_SCHEMA,
      problems: [
        {
          problemId: 'p1',
          statement: '# 問題1\n和を出力せよ。',
          starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' },
        },
        { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
      ],
    },
  };
}

describe('parseClassPackage', () => {
  it('accepts a well-formed class package and preserves the bundle', () => {
    const pkg = parseClassPackage(samplePackage());
    expect(pkg?.classId).toBe('2026-algo-week3');
    expect(pkg?.bundle.problems).toHaveLength(2);
    expect(pkg?.bundle.problems[0]!.starter?.filename).toBe('p1.c');
  });

  it('rejects a payload without the class schema', () => {
    const bad = { ...samplePackage(), schema: 'tcexam-exam/1' };
    expect(parseClassPackage(bad)).toBeNull();
  });

  it('rejects a missing or empty classId', () => {
    expect(parseClassPackage({ ...samplePackage(), classId: '' })).toBeNull();
    const { classId: _omit, ...noId } = samplePackage();
    expect(parseClassPackage(noId)).toBeNull();
  });

  it('rejects empty or malformed allowed languages', () => {
    expect(parseClassPackage({ ...samplePackage(), allowed: { languages: [] } })).toBeNull();
    expect(parseClassPackage({ ...samplePackage(), allowed: { languages: [1] } })).toBeNull();
  });

  it('rejects an invalid bundle (delegates structure to parseExamBundle)', () => {
    expect(parseClassPackage({ ...samplePackage(), bundle: { schema: EXAM_BUNDLE_SCHEMA, problems: [] } })).toBeNull();
    expect(
      parseClassPackage({ ...samplePackage(), bundle: { problems: [{ problemId: 'p1', statement: 'x' }] } })
    ).toBeNull();
  });

  it('rejects a non-object input', () => {
    expect(parseClassPackage(null)).toBeNull();
    expect(parseClassPackage('tcclass')).toBeNull();
  });
});

describe('encodeClassPackage', () => {
  it('round-trips through parse preserving classId, languages, and problems', () => {
    const parsed = parseClassPackage(JSON.parse(encodeClassPackage(samplePackage())));
    expect(parsed).not.toBeNull();
    expect(parsed!.classId).toBe(samplePackage().classId);
    expect(parsed!.allowed.languages).toEqual(['c', 'python']);
    expect(parsed!.bundle.problems[0]).toEqual(samplePackage().bundle.problems[0]);
  });

  it('normalizes CRLF in the bundle to LF (stable distribution bytes)', () => {
    const crlf = samplePackage();
    crlf.bundle.problems[0]!.statement = '# 問題1\r\n和を出力せよ。';
    expect(encodeClassPackage(crlf)).toBe(encodeClassPackage(samplePackage()));
  });
});
