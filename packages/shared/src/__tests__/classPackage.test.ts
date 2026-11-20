import { describe, expect, it } from 'vitest';
import {
  EXAM_BUNDLE_SCHEMA,
  CLASS_PACKAGE_SCHEMA,
  parseClassPackage,
  parseClassPolicy,
  encodeClassPackage,
} from '../exam/index.js';
import type { ClassPackage, ClassPolicy } from '../types/exam.js';

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
    expect(pkg?.bundle.problems[0]?.starter?.filename).toBe('p1.c');
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

// #645: 教員が決める方針 (policy)。無い旧ファイルは従来どおり読み、ある場合は 3 つとも boolean で必須。
describe('parseClassPackage policy', () => {
  const TAKE_HOME: ClassPolicy = { screenshots: false, fullscreenTracking: false, preExportBestEffort: false };

  it('reads a package without a policy as before and leaves the policy absent', () => {
    const pkg = parseClassPackage(samplePackage());
    expect(pkg).not.toBeNull();
    expect(pkg!.policy).toBeUndefined();
    expect('policy' in pkg!).toBe(false);
  });

  it('carries an explicit policy with all three booleans', () => {
    expect(parseClassPackage({ ...samplePackage(), policy: TAKE_HOME })?.policy).toEqual(TAKE_HOME);
  });

  it.each(['screenshots', 'fullscreenTracking', 'preExportBestEffort'] as const)(
    'rejects a partial policy missing %s instead of filling it in',
    (key) => {
      const { [key]: _omit, ...partial } = TAKE_HOME;
      expect(parseClassPackage({ ...samplePackage(), policy: partial })).toBeNull();
    }
  );

  it.each([
    ['a string', 'false'],
    ['a number', 0],
    ['null', null],
  ])('rejects a policy value given as %s instead of coercing it', (_label, value) => {
    expect(parseClassPackage({ ...samplePackage(), policy: { ...TAKE_HOME, screenshots: value } })).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [false, false, false]],
    ['a string', 'take-home'],
    ['an empty object', {}],
  ])('rejects a policy that is %s', (_label, policy) => {
    expect(parseClassPackage({ ...samplePackage(), policy })).toBeNull();
  });

  it('keeps only the three known keys of a policy', () => {
    const parsed = parseClassPackage({ ...samplePackage(), policy: { ...TAKE_HOME, extra: true } });
    expect(parsed?.policy).toEqual(TAKE_HOME);
  });
});

describe('parseClassPolicy', () => {
  it('returns the policy for three booleans and null for anything else', () => {
    const policy = { screenshots: true, fullscreenTracking: true, preExportBestEffort: true };
    expect(parseClassPolicy(policy)).toEqual(policy);
    expect(parseClassPolicy({ screenshots: true, fullscreenTracking: true })).toBeNull();
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

  it('writes no policy key for a package without a policy (same bytes as before #645)', () => {
    expect(JSON.parse(encodeClassPackage(samplePackage()))).not.toHaveProperty('policy');
  });

  it('round-trips an explicit policy through parse', () => {
    const policy: ClassPolicy = { screenshots: true, fullscreenTracking: true, preExportBestEffort: true };
    const parsed = parseClassPackage(JSON.parse(encodeClassPackage({ ...samplePackage(), policy })));
    expect(parsed?.policy).toEqual(policy);
  });

  it('writes the policy keys in a fixed order regardless of the input order', () => {
    const shuffled = { preExportBestEffort: false, screenshots: false, fullscreenTracking: true } as ClassPolicy;
    const encoded = JSON.parse(encodeClassPackage({ ...samplePackage(), policy: shuffled }));
    expect(Object.keys(encoded.policy)).toEqual(['screenshots', 'fullscreenTracking', 'preExportBestEffort']);
    expect(Object.keys(encoded)).toEqual(['schema', 'classId', 'allowed', 'policy', 'bundle']);
  });

  it('normalizes CRLF in the bundle to LF (stable distribution bytes)', () => {
    const crlf = samplePackage();
    crlf.bundle.problems[0]!.statement = '# 問題1\r\n和を出力せよ。';
    expect(encodeClassPackage(crlf)).toBe(encodeClassPackage(samplePackage()));
  });
});
