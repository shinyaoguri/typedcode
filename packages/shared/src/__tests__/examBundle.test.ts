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
      { problemId: 'p1', statement: '# 問題1\n和を出力せよ。', starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' } },
      { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
    ],
  };
}

describe('parseExamBundle', () => {
  it('accepts a well-formed bundle and normalizes it to the known shape', () => {
    const bundle = parseExamBundle(sampleBundle());
    expect(bundle?.problems).toHaveLength(2);
    expect(bundle?.problems[1]!.starter).toBeUndefined();
  });

  it('rejects a payload without the bundle schema', () => {
    expect(parseExamBundle({ problems: [{ problemId: 'p1', statement: 'x' }] })).toBeNull();
  });

  it('rejects an empty problem list', () => {
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [] })).toBeNull();
  });

  it('rejects duplicate problemIds within a bundle', () => {
    const dup = { schema: EXAM_BUNDLE_SCHEMA, problems: [
      { problemId: 'p1', statement: 'a' },
      { problemId: 'p1', statement: 'b' },
    ] };
    expect(parseExamBundle(dup)).toBeNull();
  });

  it('rejects a problem missing problemId or statement', () => {
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [{ statement: 'x' }] })).toBeNull();
    expect(parseExamBundle({ schema: EXAM_BUNDLE_SCHEMA, problems: [{ problemId: 'p1' }] })).toBeNull();
  });

  it('rejects a malformed starter', () => {
    const bad = { schema: EXAM_BUNDLE_SCHEMA, problems: [{ problemId: 'p1', statement: 'x', starter: { filename: 'a.c' } }] };
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
