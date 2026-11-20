/**
 * 仕様別の入口に隠れた入力が無いことを固定する (#809 受け入れ条件 3 / ADR-0053 §4)。
 *
 * - 同じ入力・同じ信頼・同じ方針・同じ評価時刻なら同じ結果
 * - 時計 (`Date.now`・`performance.now`) もネットワーク (`fetch`) も使わない
 * - 評価時刻と信頼の snapshot の識別を結果に残し、鍵一覧が変われば識別も変わる
 * - 信頼と評価時刻は必須で、欠ければ既定の registry に落とさず throw する
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyProofBySpec, type SpecVerificationContext } from '../index.js';
import {
  EVALUATION_TIME,
  FULL_VERIFY_TIMEOUT_MS,
  frozenCheckpointKey,
  frozenContext,
  loadFrozenExamPackage,
  loadFrozenProof,
} from './fixtures/frozenProofFixtures.js';

/** 3 つの凍結 proof を full で検証する (token・署名 cp・exam 束縛の経路をすべて通す) */
async function verifyAllFrozenProofs(): Promise<void> {
  await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext());
  for (const fixture of ['exam-v1', 'exam-v2'] as const) {
    await verifyProofBySpec(loadFrozenProof(fixture), frozenContext({ examPackage: loadFrozenExamPackage(fixture) }));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('verifyProofBySpec determinism', () => {
  it(
    'returns deeply equal results for the same input, trust, policy and evaluation time',
    async () => {
      const context = frozenContext({ policy: { requireRootAnchor: true } });
      const first = await verifyProofBySpec(loadFrozenProof('casual-anchored'), context);
      const second = await verifyProofBySpec(loadFrozenProof('casual-anchored'), context);
      expect(second).toEqual(first);
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it(
    'never reads the wall clock',
    async () => {
      const now = vi.spyOn(Date, 'now');
      await verifyAllFrozenProofs();
      expect(now).not.toHaveBeenCalled();
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it(
    'never reads the monotonic clock',
    async () => {
      const now = vi.spyOn(performance, 'now');
      await verifyAllFrozenProofs();
      expect(now).not.toHaveBeenCalled();
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it(
    'never touches the network',
    async () => {
      const fetchStub = vi.fn(() => {
        throw new Error('verifyProofBySpec must not fetch');
      });
      vi.stubGlobal('fetch', fetchStub);
      await verifyAllFrozenProofs();
      expect(fetchStub).not.toHaveBeenCalled();
    },
    FULL_VERIFY_TIMEOUT_MS
  );
});

describe('verifyProofBySpec trust snapshot and evaluation time', () => {
  it('copies the evaluation time verbatim into the result', async () => {
    const time = '2031-02-03T04:05:06.789Z';
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      frozenContext({ mode: 'fast', evaluationTime: time })
    );
    expect(result.evaluation).toEqual({ time, mode: 'fast' });
  });

  it('does not change the verdict when only the evaluation time differs (legacy 1.2.0 ignores it)', async () => {
    const at = (evaluationTime: string) =>
      verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast', evaluationTime }));
    const [early, late] = await Promise.all([at('2000-01-01T00:00:00.000Z'), at('2099-01-01T00:00:00.000Z')]);
    expect({ ...late, evaluation: early.evaluation }).toEqual(early);
  });

  it('omits the label from the snapshot when the caller gives none', async () => {
    const result = await verifyProofBySpec({ version: '2.0.0' }, frozenContext({ mode: 'fast' }));
    expect(result.trust.snapshot).toStrictEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('records the trust label and a SHA-256 digest of the key lists', async () => {
    const context = frozenContext({ mode: 'fast' });
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), {
      ...context,
      trust: { ...context.trust, label: 'registry-2026-11' },
    });
    expect(result.trust.snapshot).toEqual({
      label: 'registry-2026-11',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('records the snapshot digest even when the input is not supported', async () => {
    const supported = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast' }));
    const unsupported = await verifyProofBySpec({ version: '2.0.0' }, frozenContext({ mode: 'fast' }));
    expect(unsupported.trust.snapshot).toEqual(supported.trust.snapshot);
  });

  it('changes the digest when a key list changes', async () => {
    const context = frozenContext({ mode: 'fast' });
    const base = await verifyProofBySpec({ version: '2.0.0' }, context);
    const revoked = await verifyProofBySpec(
      { version: '2.0.0' },
      {
        ...context,
        trust: {
          ...context.trust,
          checkpointKeys: [{ ...frozenCheckpointKey(), status: 'revoked', revokedAt: '2027-01-01T00:00:00.000Z' }],
        },
      }
    );
    expect(revoked.trust.snapshot.digest).not.toBe(base.trust.snapshot.digest);
  });

  it('changes the digest when the exam authority key list changes', async () => {
    const context = frozenContext({ mode: 'fast' });
    const base = await verifyProofBySpec({ version: '2.0.0' }, context);
    const empty = await verifyProofBySpec(
      { version: '2.0.0' },
      { ...context, trust: { ...context.trust, examAuthorityKeys: [] } }
    );
    expect(empty.trust.snapshot.digest).not.toBe(base.trust.snapshot.digest);
  });
});

describe('verifyProofBySpec required context', () => {
  const proof = loadFrozenProof('casual-anchored');

  it('throws a descriptive error when no context is given', async () => {
    await expect(verifyProofBySpec(proof, undefined as unknown as SpecVerificationContext)).rejects.toThrow(
      /context\.trust/
    );
  });

  it('throws when the evaluation time is a number instead of an ISO string', async () => {
    const context = frozenContext({ evaluationTime: 0 as unknown as string });
    await expect(verifyProofBySpec(proof, context)).rejects.toThrow(/evaluationTime/);
  });

  it('throws instead of falling back to the bundled registry when trust is missing', async () => {
    const context = { evaluationTime: EVALUATION_TIME } as unknown as SpecVerificationContext;
    await expect(verifyProofBySpec(proof, context)).rejects.toThrow(/context\.trust/);
  });

  it('throws when a key list is not an array', async () => {
    const context = {
      evaluationTime: EVALUATION_TIME,
      trust: { checkpointKeys: [frozenCheckpointKey()] },
    } as unknown as SpecVerificationContext;
    await expect(verifyProofBySpec(proof, context)).rejects.toThrow(/context\.trust/);
  });

  it('throws instead of reading the clock when the evaluation time is missing', async () => {
    const { evaluationTime: _omit, ...rest } = frozenContext();
    await expect(verifyProofBySpec(proof, rest as SpecVerificationContext)).rejects.toThrow(/evaluationTime/);
  });

  it('throws when the evaluation time is not a date', async () => {
    await expect(verifyProofBySpec(proof, frozenContext({ evaluationTime: 'tomorrow' }))).rejects.toThrow(
      /evaluationTime/
    );
  });

  it('defaults to the full mode like verifyProofFile', async () => {
    const { mode: _omit, ...rest } = frozenContext();
    const result = await verifyProofBySpec({ version: '2.0.0' }, rest);
    expect(result.evaluation.mode).toBe('full');
  });
});
