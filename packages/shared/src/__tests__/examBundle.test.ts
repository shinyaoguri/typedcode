import { describe, expect, it } from 'vitest';
import {
  EXAM_BUNDLE_SCHEMA,
  parseExamBundle,
  decodeExamPlaintext,
  encodeExamBundle,
  computeBundleProblemHash,
  computeExamChainRoot,
} from '../exam/index.js';
import type { ExamBundle } from '../types/exam.js';

function sampleBundle(): ExamBundle {
  return {
    schema: EXAM_BUNDLE_SCHEMA,
    problems: [
      {
        problemId: 'p1',
        statement: '# 問題1\n和を出力せよ。',
        starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' },
      },
      { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
    ],
  };
}

describe('parseExamBundle', () => {
  it('accepts a well-formed bundle and normalizes it to the known shape', () => {
    const bundle = parseExamBundle(sampleBundle());
    expect(bundle?.problems).toHaveLength(2);
    expect(bundle?.problems[1]?.starter).toBeUndefined();
  });

  it('rejects a payload without the bundle schema', () => {
    expect(parseExamBundle({ problems: [{ problemId: 'p1', statement: 'x' }] })).toBeNull();
  });

  it('rejects an empty problem list', () => {
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [] })).toBeNull();
  });

  it('rejects duplicate problemIds within a bundle', () => {
    const dup = {
      schema: EXAM_BUNDLE_SCHEMA,
      problems: [
        { problemId: 'p1', statement: 'a' },
        { problemId: 'p1', statement: 'b' },
      ],
    };
    expect(parseExamBundle(dup)).toBeNull();
  });

  it('rejects a problem missing problemId or statement', () => {
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [{ statement: 'x' }] })).toBeNull();
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [{ problemId: 'p1' }] })).toBeNull();
  });

  it('rejects a malformed starter', () => {
    const bad = {
      schema: EXAM_BUNDLE_SCHEMA,
      problems: [{ problemId: 'p1', statement: 'x', starter: { filename: 'a.c' } }],
    };
    expect(parseExamBundle(bad)).toBeNull();
  });
});

describe('decodeExamPlaintext', () => {
  it('decodes an encoded bundle as kind=bundle', () => {
    const decoded = decodeExamPlaintext(encodeExamBundle(sampleBundle()));
    expect(decoded.kind).toBe('bundle');
    expect(decoded.kind === 'bundle' && decoded.bundle.problems).toHaveLength(2);
  });

  it('treats raw markdown (non-JSON) as a legacy single problem', () => {
    const decoded = decodeExamPlaintext('# 問題\n標準入力から…');
    expect(decoded.kind).toBe('legacy');
    expect(decoded.kind === 'legacy' && decoded.statement).toBe('# 問題\n標準入力から…');
  });

  it('treats JSON without the bundle schema as legacy (backward compatible)', () => {
    const json = JSON.stringify({ hello: 'world' });
    const decoded = decodeExamPlaintext(json);
    expect(decoded.kind).toBe('legacy');
    expect(decoded.kind === 'legacy' && decoded.statement).toBe(json);
  });
});

describe('encodeExamBundle', () => {
  it('round-trips through decode preserving problems and starters', () => {
    const decoded = decodeExamPlaintext(encodeExamBundle(sampleBundle()));
    if (decoded.kind !== 'bundle') throw new Error('expected bundle');
    expect(decoded.bundle.problems[0]).toEqual(sampleBundle().problems[0]);
  });

  it('is deterministic regardless of problem object key order', () => {
    const a: ExamBundle = { schema: EXAM_BUNDLE_SCHEMA, problems: [{ problemId: 'p1', statement: 's' }] };
    const b = { schema: EXAM_BUNDLE_SCHEMA, problems: [{ statement: 's', problemId: 'p1' }] } as ExamBundle;
    expect(encodeExamBundle(a)).toBe(encodeExamBundle(b));
  });
});

describe('computeBundleProblemHash', () => {
  it('is stable across CRLF vs LF newlines', async () => {
    const lf = await computeBundleProblemHash({ problemId: 'p1', statement: 'a\nb' });
    const crlf = await computeBundleProblemHash({ problemId: 'p1', statement: 'a\r\nb' });
    expect(lf).toBe(crlf);
  });

  it('changes when the problemId changes (relabeling is detectable)', async () => {
    const h1 = await computeBundleProblemHash({ problemId: 'p1', statement: 'same' });
    const h2 = await computeBundleProblemHash({ problemId: 'p2', statement: 'same' });
    expect(h1).not.toBe(h2);
  });

  it('changes when the starter content changes', async () => {
    const base = { problemId: 'p1', statement: 's', starter: { filename: 'a.c', language: 'c', content: 'x' } };
    const changed = { ...base, starter: { ...base.starter, content: 'y' } };
    expect(await computeBundleProblemHash(base)).not.toBe(await computeBundleProblemHash(changed));
  });
});

describe('computeExamChainRoot (v2 binding)', () => {
  const fp = 'a'.repeat(64);
  const nonce = 'b'.repeat(64);
  const pkg = 'c'.repeat(64);
  const token = 'ABCD1234';
  const pch = 'd'.repeat(64);

  it('omitting problemContentHash is byte-identical to the v1 formula', async () => {
    const v1 = await computeExamChainRoot(fp, nonce, pkg, token);
    const v1Explicit = await computeExamChainRoot(fp, nonce, pkg, token, undefined);
    expect(v1Explicit).toBe(v1);
  });

  it('binding a per-problem hash (v2) differs from v1', async () => {
    const v1 = await computeExamChainRoot(fp, nonce, pkg, token);
    const v2 = await computeExamChainRoot(fp, nonce, pkg, token, pch);
    expect(v2).not.toBe(v1);
  });

  it('differs per problem within the same package and token', async () => {
    const a = await computeExamChainRoot(fp, nonce, pkg, token, 'd'.repeat(64));
    const b = await computeExamChainRoot(fp, nonce, pkg, token, 'e'.repeat(64));
    expect(a).not.toBe(b);
  });
});

// 入出力例 (#648 / ADR-0048)
describe('problem examples', () => {
  const examples = [
    { name: '例1', stdin: '3 5\n', stdout: '8\n' },
    { name: '入力なし', stdin: '', stdout: 'hello\n' },
  ];

  function bundleWith(problemExtra: Record<string, unknown>): unknown {
    return { schema: EXAM_BUNDLE_SCHEMA, problems: [{ problemId: 'p1', statement: 's', ...problemExtra }] };
  }

  it('keeps the problem hash of problems without examples byte-identical to the pre-examples formula', async () => {
    // 期待値は examples を足す前 (HEAD) の canonicalProblem で計算した値。ここが動くと既存の .tcexam の束縛が壊れる
    const [p1, p2] = sampleBundle().problems;
    expect(await computeBundleProblemHash(p1!)).toBe(
      '20a9066479869a748efae472bfc528899c9537e12aca668249243b4d49d05d27'
    );
    expect(await computeBundleProblemHash(p2!)).toBe(
      'e4257e8f45548b450df34413236f5bfdb83183a25bccf310b4732c8981ff2fa3'
    );
  });

  it('treats an empty examples array as no examples for the problem hash', async () => {
    const p1 = sampleBundle().problems[0]!;
    expect(await computeBundleProblemHash({ ...p1, examples: [] })).toBe(await computeBundleProblemHash(p1));
  });

  it('changes the problem hash when one character of an example stdout changes', async () => {
    const base = { problemId: 'p1', statement: 's', examples };
    const changed = { ...base, examples: [{ ...examples[0]!, stdout: '9\n' }, examples[1]!] };
    expect(await computeBundleProblemHash(changed)).not.toBe(await computeBundleProblemHash(base));
  });

  it('keeps the problem hash stable across CRLF vs LF in example stdin and stdout', async () => {
    const lf = { problemId: 'p1', statement: 's', examples: [{ name: 'a', stdin: '1\n2\n', stdout: '3\n' }] };
    const crlf = { problemId: 'p1', statement: 's', examples: [{ name: 'a', stdin: '1\r\n2\r\n', stdout: '3\r\n' }] };
    expect(await computeBundleProblemHash(crlf)).toBe(await computeBundleProblemHash(lf));
  });

  it('does not match the hash of the same problem with its examples dropped (an older editor binds a different hash)', async () => {
    // 旧 editor は parseExamBundle で examples を落としてからハッシュを root に焼く。新しい検証側は examples 込みで
    // 計算し直すので束縛が食い違う。入出力例付きの配布は新しい editor が前提 (ADR-0048)
    const withExamples = { problemId: 'p1', statement: 's', examples };
    const droppedByOldEditor = { problemId: 'p1', statement: 's' };
    expect(await computeBundleProblemHash(droppedByOldEditor)).not.toBe(await computeBundleProblemHash(withExamples));
  });

  it('accepts well-formed examples and drops unknown keys inside each example', () => {
    const parsed = parseExamBundle(bundleWith({ examples: [{ ...examples[0], hidden: true }, examples[1]] }));
    expect(parsed?.problems[0]?.examples).toEqual(examples);
  });

  it('normalizes an empty examples array to no examples', () => {
    const parsed = parseExamBundle(bundleWith({ examples: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.problems[0]).not.toHaveProperty('examples');
  });

  it('rejects the bundle when examples is not an array', () => {
    expect(parseExamBundle(bundleWith({ examples: { name: 'a', stdin: '', stdout: '' } }))).toBeNull();
  });

  it('rejects the bundle when an example is not an object', () => {
    expect(parseExamBundle(bundleWith({ examples: ['3 5'] }))).toBeNull();
  });

  it('rejects the bundle when an example has an empty name', () => {
    expect(parseExamBundle(bundleWith({ examples: [{ name: '', stdin: '', stdout: '' }] }))).toBeNull();
  });

  it('rejects the bundle when an example stdin is not a string', () => {
    expect(parseExamBundle(bundleWith({ examples: [{ name: 'a', stdin: 3, stdout: '8' }] }))).toBeNull();
  });

  it('rejects the bundle when an example stdout is missing', () => {
    expect(parseExamBundle(bundleWith({ examples: [{ name: 'a', stdin: '' }] }))).toBeNull();
  });

  it('round-trips examples through encode and decode', () => {
    const bundle: ExamBundle = {
      schema: EXAM_BUNDLE_SCHEMA,
      problems: [{ problemId: 'p1', statement: 's', examples }],
    };
    const decoded = decodeExamPlaintext(encodeExamBundle(bundle));
    if (decoded.kind !== 'bundle') throw new Error('expected bundle');
    expect(decoded.bundle.problems[0]?.examples).toEqual(examples);
  });
});
