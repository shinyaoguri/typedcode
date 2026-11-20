/**
 * 仕様別の入口の識別 (exact dispatch) を固定する (#809 受け入れ条件 2 / ADR-0053 §2)。
 *
 * - 登録済みの版 (いまは 1.2.0 だけ) は legacy の検証器で読み、それ以外の正しい形の版は `unsupported`
 * - 識別子や構造が不正なら `malformed`
 * - `unsupported` / `malformed` では legacy の検証器を呼ばず、すべての検査が `not-checked`
 *
 * 負の対照: 凍結 proof の `version` だけを書き換えた入力は、`version` が `typingProofHash` の入力ではないので
 * ハッシュが合ったまま。legacy の検証器へ fallback していれば検査は pass になる (下の `still verifies` が示す)。
 */

import { describe, expect, it } from 'vitest';
import { identifyProofSpec, verifyProofBySpec, verifyProofFile, type SpecChecks } from '../index.js';
import { frozenCheckpointKey, frozenContext, loadFrozenProof } from './fixtures/frozenProofFixtures.js';

const ALL_NOT_CHECKED: SpecChecks = {
  structure: { status: 'not-checked' },
  metadata: { status: 'not-checked' },
  root: { status: 'not-checked' },
  chain: { status: 'not-checked' },
  posw: { status: 'not-checked' },
  finalHash: { status: 'not-checked' },
  content: { status: 'not-checked' },
  checkpoints: { status: 'not-checked' },
  signedCheckpoints: { status: 'not-checked' },
  sessionAnchor: { status: 'not-checked' },
  problemBinding: { status: 'not-checked' },
};

/** 凍結 casual proof の version だけを差し替える (それ以外のバイトは原本のまま) */
function withVersion(version: unknown): unknown {
  return { ...loadFrozenProof('casual-anchored'), version };
}

describe('verifyProofBySpec: versions without a registered verifier', () => {
  it.each(['1.1.0', '1.0.0', '1.3.0', '2.0.0'])('reports %s as unsupported with its parsed version', async (v) => {
    const result = await verifyProofBySpec(withVersion(v), frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'unsupported', declared: { version: v }, code: 'version-not-registered' });
  });

  it.each(['1.1.0', '1.0.0', '1.3.0', '2.0.0'])('runs no check on a proof renamed to %s', async (v) => {
    const result = await verifyProofBySpec(withVersion(v), frozenContext({ mode: 'fast' }));
    expect(result.checks).toEqual(ALL_NOT_CHECKED);
  });

  it.each(['1.1.0', '1.0.0', '1.3.0', '2.0.0'])('does not evaluate integrity or acceptance for %s', async (v) => {
    const result = await verifyProofBySpec(
      withVersion(v),
      frozenContext({ mode: 'fast', policy: { requireRootAnchor: true } })
    );
    expect({ integrity: result.integrity, evaluated: result.acceptance.evaluated, detail: result.detail }).toEqual({
      integrity: 'not-evaluated',
      evaluated: false,
      detail: undefined,
    });
  });

  it('reports no limitation, key or policy violation for an unsupported version', async () => {
    const result = await verifyProofBySpec(
      withVersion('1.1.0'),
      frozenContext({ mode: 'fast', policy: { requireRootAnchor: true } })
    );
    expect({
      limitations: result.limitations,
      keys: result.trust.keys,
      violations: result.acceptance.violations,
    }).toEqual({ limitations: [], keys: [], violations: [] });
  });

  it('would pass a proof renamed to 1.1.0 if it fell back to the legacy verifier (negative control)', async () => {
    const renamed = withVersion('1.1.0') as Parameters<typeof verifyProofFile>[0];
    const legacy = await verifyProofFile(renamed, undefined, {
      mode: 'fast',
      signedCheckpointKeyRegistry: [frozenCheckpointKey()],
    });
    expect(legacy.integrityValid).toBe(true);
  });
});

describe('verifyProofBySpec: malformed identifiers', () => {
  it.each([
    { label: 'a non-numeric version', version: 'abc' },
    { label: 'a numeric version', version: 120 },
    { label: 'a pre-release version', version: '1.2.0-beta' },
    { label: 'a two-part version', version: '1.2' },
    { label: 'a version with a leading zero', version: '01.2.0' },
  ])('reports $label as malformed without echoing it', async ({ version }) => {
    const result = await verifyProofBySpec(withVersion(version), frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'malformed', code: 'version-malformed' });
  });

  it('reports a missing version as malformed', async () => {
    const { version: _omit, ...rest } = loadFrozenProof('casual-anchored');
    const result = await verifyProofBySpec(rest, frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'malformed', code: 'version-missing' });
  });

  it.each([
    { label: 'null', input: null },
    { label: 'an array', input: [] },
    { label: 'a string', input: '{"version":"1.2.0"}' },
  ])('reports $label as malformed because it is not an object', async ({ input }) => {
    const result = await verifyProofBySpec(input, frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'malformed', code: 'not-an-object' });
  });

  it('runs no check on a malformed version', async () => {
    const result = await verifyProofBySpec(withVersion('abc'), frozenContext({ mode: 'fast' }));
    expect(result.checks).toEqual(ALL_NOT_CHECKED);
  });
});

describe('verifyProofBySpec: new-format identifiers (kind / specVersion)', () => {
  it('reports a well-formed kind and specVersion as unsupported while none is registered', async () => {
    const input = { ...loadFrozenProof('casual-anchored'), kind: 'typing-proof', specVersion: 1 };
    const result = await verifyProofBySpec(input, frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({
      status: 'unsupported',
      declared: { kind: 'typing-proof', specVersion: 1 },
      code: 'kind-not-registered',
    });
  });

  it('does not fall back to the legacy verifier when a kind sits beside version 1.2.0', async () => {
    const input = { ...loadFrozenProof('casual-anchored'), kind: 'typing-proof', specVersion: 1 };
    const result = await verifyProofBySpec(input, frozenContext({ mode: 'fast' }));
    expect(result.checks).toEqual(ALL_NOT_CHECKED);
  });

  it.each([
    {
      label: 'a kind outside the allowed characters',
      kind: 'Typing Proof<x>',
      specVersion: 1,
      declared: { specVersion: 1 },
    },
    { label: 'a kind with a trailing suffix', kind: 'typing-proof<x>', specVersion: 1, declared: { specVersion: 1 } },
    { label: 'a kind with a leading prefix', kind: 'X-typing-proof', specVersion: 1, declared: { specVersion: 1 } },
    { label: 'a non-string kind', kind: ['typing-proof'], specVersion: 1, declared: { specVersion: 1 } },
    { label: 'a fractional specVersion', kind: 'typing-proof', specVersion: 1.5, declared: { kind: 'typing-proof' } },
    { label: 'a string specVersion', kind: 'typing-proof', specVersion: '1', declared: { kind: 'typing-proof' } },
    { label: 'a zero specVersion', kind: 'typing-proof', specVersion: 0, declared: { kind: 'typing-proof' } },
    {
      label: 'a missing specVersion',
      kind: 'typing-proof',
      specVersion: undefined,
      declared: { kind: 'typing-proof' },
    },
  ])('reports $label as malformed and echoes only the well-formed part', async ({ kind, specVersion, declared }) => {
    const input: Record<string, unknown> = { ...loadFrozenProof('casual-anchored'), kind };
    if (specVersion !== undefined) input.specVersion = specVersion;
    const result = await verifyProofBySpec(input, frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'malformed', declared, code: 'kind-malformed' });
  });

  it('treats a lone specVersion key as a new-format identifier', () => {
    expect(identifyProofSpec({ version: '1.2.0', specVersion: 1 })).toEqual({
      status: 'malformed',
      declared: { specVersion: 1 },
      code: 'kind-malformed',
    });
  });
});

describe('verifyProofBySpec: version 1.2.0 with a structure the legacy verifier cannot read', () => {
  /** JSON を parse した値を、構造を壊すために object として触る */
  const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
  const firstCheckpoint = (p: Record<string, unknown>): Record<string, unknown> =>
    record((p.checkpoints as unknown[])[0]);

  it.each([
    { label: 'a null event', mutate: (p: Record<string, unknown>) => (record(p.proof).events as unknown[]).push(null) },
    { label: 'no typingProofHash', mutate: (p: Record<string, unknown>) => delete p.typingProofHash },
    { label: 'no typingProofData', mutate: (p: Record<string, unknown>) => delete p.typingProofData },
    {
      label: 'typingProofData without metadata',
      mutate: (p: Record<string, unknown>) => delete record(p.typingProofData).metadata,
    },
    { label: 'no content', mutate: (p: Record<string, unknown>) => delete p.content },
    { label: 'no proof.events', mutate: (p: Record<string, unknown>) => delete record(p.proof).events },
    { label: 'a non-array checkpoints', mutate: (p: Record<string, unknown>) => (p.checkpoints = {}) },
    { label: 'a null checkpoint', mutate: (p: Record<string, unknown>) => (p.checkpoints as unknown[]).push(null) },
    {
      label: 'a signature without a payload',
      mutate: (p: Record<string, unknown>) => delete record(firstCheckpoint(p).signature).payload,
    },
    { label: 'a non-object signature', mutate: (p: Record<string, unknown>) => (firstCheckpoint(p).signature = 'sig') },
    {
      label: 'a token without a payload',
      mutate: (p: Record<string, unknown>) => delete record(p.sessionStartToken).payload,
    },
    { label: 'a non-object token', mutate: (p: Record<string, unknown>) => (p.sessionStartToken = 'token') },
    { label: 'a non-object exam block', mutate: (p: Record<string, unknown>) => (p.exam = 'exam') },
    { label: 'a non-object fingerprint', mutate: (p: Record<string, unknown>) => (p.fingerprint = 'fp') },
  ])('reports $label as malformed instead of running the legacy verifier', async ({ mutate }) => {
    const proof = record(loadFrozenProof('casual-anchored'));
    mutate(proof);
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.support).toEqual({ status: 'malformed', declared: { version: '1.2.0' }, code: 'structure-invalid' });
  });

  it('accepts null for the optional blocks the legacy verifier skips', () => {
    const proof = { ...loadFrozenProof('casual-anchored'), sessionStartToken: null, exam: null, fingerprint: null };
    expect(identifyProofSpec(proof).status).toBe('supported');
  });
});

describe('verifyProofBySpec: a known version whose signed checkpoint signature was altered', () => {
  async function verifyWithAlteredSignature() {
    const proof = loadFrozenProof('casual-anchored');
    const envelope = proof.checkpoints![0]!.signature!;
    const last = envelope.signature.at(-1) === '0' ? '1' : '0';
    envelope.signature = envelope.signature.slice(0, -1) + last;
    return verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
  }

  it('reports the integrity as failed', async () => {
    expect((await verifyWithAlteredSignature()).integrity).toBe('failed');
  });

  it('reports the signed checkpoints as failed evidence rather than an untrusted key', async () => {
    expect((await verifyWithAlteredSignature()).checks.signedCheckpoints).toEqual({
      status: 'fail',
      code: 'signed-checkpoint-invalid',
    });
  });

  it('does not evaluate the acceptance policy', async () => {
    expect((await verifyWithAlteredSignature()).acceptance.evaluated).toBe(false);
  });
});
