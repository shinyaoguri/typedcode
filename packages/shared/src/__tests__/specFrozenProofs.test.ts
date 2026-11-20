/**
 * 凍結 proof を仕様別の入口 (`verifyProofBySpec`) で検証し、共通の結果を固定する (#809 受け入れ条件 1)。
 *
 * `frozenProofs.test.ts` は同じ fixture を `verifyProofFile` 直呼びで固定している。こちらは、版の識別で
 * legacy 1.2.0 の検証器が選ばれ、その結果が共通の結果の各軸に写ることを固定する。fixture は読むだけで
 * 作り直さない (fixtures/frozen-proofs/README.md)。落ちたら fixture ではなく入口か写像を疑う。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { verifyProofBySpec, type SpecVerificationResult } from '../index.js';
import {
  EVALUATION_TIME,
  FULL_VERIFY_TIMEOUT_MS,
  frozenContext,
  loadFrozenExamPackage,
  loadFrozenProof,
} from './fixtures/frozenProofFixtures.js';

describe('verifyProofBySpec on the frozen casual proof anchored by a token and signed checkpoints', () => {
  let result: SpecVerificationResult;

  beforeAll(async () => {
    result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext());
  }, FULL_VERIFY_TIMEOUT_MS);

  it('selects the legacy 1.2.0 verifier by exact version match', () => {
    expect(result.support).toEqual({
      status: 'supported',
      spec: 'legacy-typing-proof@1.2.0',
      declared: { version: '1.2.0' },
    });
  });

  it('reports the integrity as proven with every PoSW recomputed', () => {
    expect(result.integrity).toBe('proven');
  });

  it('reports every applicable check as passed and the exam binding as not applicable', () => {
    expect(result.checks).toEqual({
      structure: { status: 'pass' },
      metadata: { status: 'pass' },
      root: { status: 'pass' },
      chain: { status: 'pass' },
      posw: { status: 'pass' },
      finalHash: { status: 'pass' },
      content: { status: 'pass' },
      checkpoints: { status: 'pass' },
      signedCheckpoints: { status: 'pass' },
      sessionAnchor: { status: 'pass' },
      problemBinding: { status: 'not-applicable' },
    });
  });

  it('lists only the unbound legacy version as a limitation', () => {
    expect(result.limitations).toEqual(['legacy-spec-version-unbound']);
  });

  it('records the token key and the checkpoint key as trusted at their evidence anchors', () => {
    expect(result.trust.keys).toEqual([
      {
        role: 'session-token',
        keyId: 'frozen-fixture-checkpoint-0001',
        status: 'trusted',
        anchor: '2026-11-04T16:01:02.810Z',
      },
      {
        role: 'checkpoint',
        keyId: 'frozen-fixture-checkpoint-0001',
        status: 'trusted',
        anchor: '2026-11-04T16:01:05.869Z',
      },
    ]);
  });

  it('evaluates the acceptance policy because the integrity holds', () => {
    expect(result.acceptance.evaluated).toBe(true);
  });

  it('copies the evaluation time and mode from the context', () => {
    expect(result.evaluation).toEqual({ time: EVALUATION_TIME, mode: 'full' });
  });

  it('keeps the legacy verifier result as a non-contract detail', () => {
    expect(result.detail?.legacyProof.valid).toBe(true);
  });
});

describe.each([
  { fixture: 'exam-v1' as const, signedCheckpoints: 'not-applicable', releaseTime: '2026-11-04T15:01:05.827Z' },
  { fixture: 'exam-v2' as const, signedCheckpoints: 'pass', releaseTime: '2026-11-04T15:01:07.075Z' },
])('verifyProofBySpec on the frozen $fixture proof with its package', ({ fixture, signedCheckpoints, releaseTime }) => {
  let result: SpecVerificationResult;

  beforeAll(async () => {
    result = await verifyProofBySpec(
      loadFrozenProof(fixture),
      frozenContext({ examPackage: loadFrozenExamPackage(fixture) })
    );
  }, FULL_VERIFY_TIMEOUT_MS);

  it('selects the legacy 1.2.0 verifier by exact version match', () => {
    expect(result.support.spec).toBe('legacy-typing-proof@1.2.0');
  });

  it('reports the integrity as proven with every PoSW recomputed', () => {
    expect(result.integrity).toBe('proven');
  });

  it('reports the exam root and the problem binding as passed without a session anchor', () => {
    expect(result.checks).toEqual({
      structure: { status: 'pass' },
      metadata: { status: 'pass' },
      root: { status: 'pass' },
      chain: { status: 'pass' },
      posw: { status: 'pass' },
      finalHash: { status: 'pass' },
      content: { status: 'pass' },
      checkpoints: { status: 'pass' },
      signedCheckpoints: { status: signedCheckpoints },
      sessionAnchor: { status: 'not-applicable' },
      problemBinding: { status: 'pass' },
    });
  });

  it('marks the authority key anchor as self-declared besides the unbound legacy version', () => {
    expect(result.limitations).toEqual(['legacy-spec-version-unbound', 'exam-key-anchor-self-declared']);
  });

  it('records the exam authority key as trusted at the package release time', () => {
    expect(result.trust.keys.filter((k) => k.role === 'exam-authority')).toEqual([
      { role: 'exam-authority', keyId: 'frozen-fixture-exam-0001', status: 'trusted', anchor: releaseTime },
    ]);
  });

  it('runs the binding itself and keeps its result as a non-contract detail', () => {
    expect(result.detail?.examBinding?.valid).toBe(true);
  });
});
