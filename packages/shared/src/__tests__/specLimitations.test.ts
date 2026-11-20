/**
 * 保証範囲の制限と鍵の信頼を個別に示すことを固定する (#809 受け入れ条件 4 / ADR-0053 §4)。
 *
 * - fast の PoSW 省略、問題パッケージの不足、legacy の版の未束縛は `limitations` に出る
 * - 未知の鍵・失効した鍵は `trust.keys` に列挙型で出て、その検査は pass にならない
 * - 鍵を信頼できないことは整合性 (改ざん) と混ぜない
 */

import { describe, expect, it } from 'vitest';
import { verifyProofBySpec, type CheckpointPublicKey, type SpecVerificationContext } from '../index.js';
import {
  frozenCheckpointKey,
  frozenContext,
  frozenExamAuthorityKey,
  loadFrozenExamPackage,
  loadFrozenProof,
} from './fixtures/frozenProofFixtures.js';

/** 信頼する checkpoint 鍵だけを差し替えた fast の context */
function withCheckpointKeys(checkpointKeys: CheckpointPublicKey[]): SpecVerificationContext {
  const context = frozenContext({ mode: 'fast' });
  return { ...context, trust: { ...context.trust, checkpointKeys } };
}

/** token の issuedAt (2026-11-04T16:01:02.810Z) と全署名 cp より前に失効させた fixture の鍵 */
const revokedBeforeAnchors = (): CheckpointPublicKey => ({
  ...frozenCheckpointKey(),
  status: 'revoked',
  revokedAt: '2026-11-04T16:00:00.000Z',
});

/** 全 anchor より後に失効させた fixture の鍵 */
const revokedAfterAnchors = (): CheckpointPublicKey => ({
  ...frozenCheckpointKey(),
  status: 'revoked',
  revokedAt: '2027-01-01T00:00:00.000Z',
});

describe('verifyProofBySpec: fast mode', () => {
  it('reports PoSW as not checked instead of passed', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast' }));
    expect(result.checks.posw).toEqual({ status: 'not-checked' });
  });

  it('lists the skipped PoSW recomputation as a limitation', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast' }));
    expect(result.limitations).toContain('posw-not-recomputed');
  });

  it('reports the integrity as partial rather than proven', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast' }));
    expect(result.integrity).toBe('partial');
  });
});

describe('verifyProofBySpec: legacy version binding', () => {
  it.each(['casual-anchored', 'exam-v1', 'exam-v2'] as const)(
    'always lists the unbound legacy version for %s',
    async (fixture) => {
      const result = await verifyProofBySpec(loadFrozenProof(fixture), frozenContext({ mode: 'fast' }));
      expect(result.limitations[0]).toBe('legacy-spec-version-unbound');
    }
  );
});

describe('verifyProofBySpec: exam proof without its problem package', () => {
  it('reports the problem binding as not checked', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('exam-v2'), frozenContext({ mode: 'fast' }));
    expect(result.checks.problemBinding).toEqual({ status: 'not-checked' });
  });

  it('lists the missing package as a limitation', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), frozenContext());
    expect(result.limitations).toEqual(['legacy-spec-version-unbound', 'problem-package-not-provided']);
  });

  it('records no authority key without a package', async () => {
    // exam-v1 は署名 cp も token も持たないので、鍵は 1 つも現れない
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), frozenContext({ mode: 'fast' }));
    expect(result.trust.keys).toEqual([]);
  });

  it('ignores a session token bundled with an exam proof, as the exam root does', async () => {
    const proof = loadFrozenProof('exam-v1');
    proof.sessionStartToken = loadFrozenProof('casual-anchored').sessionStartToken;
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect({ sessionAnchor: result.checks.sessionAnchor, keys: result.trust.keys }).toEqual({
      sessionAnchor: { status: 'not-applicable' },
      keys: [],
    });
  });

  it('does not exempt the exam from the root anchor requirement', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v2'),
      frozenContext({ policy: { requireRootAnchor: true } })
    );
    expect(result.acceptance.violations.map((v) => v.code)).toEqual(['root-anchor-missing']);
  });

  it('exempts the exam from the root anchor requirement once the entry verified the binding itself', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v2'),
      frozenContext({ policy: { requireRootAnchor: true }, examPackage: loadFrozenExamPackage('exam-v2') })
    );
    expect(result.acceptance.violations).toEqual([]);
  });
});

describe('verifyProofBySpec: exam package problems', () => {
  it('fails the problem binding when the package is not a manifest', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: { formatVersion: 1 } })
    );
    expect(result.checks.problemBinding).toEqual({ status: 'fail', code: 'exam-package-malformed' });
  });

  it('reports an unreadable package as a failed binding in the integrity', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: { formatVersion: 1 } })
    );
    expect(result.integrity).toBe('failed');
  });

  it('adds no key and no limitation of its own for an unreadable package', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: { formatVersion: 1 } })
    );
    expect({ limitations: result.limitations, keys: result.trust.keys }).toEqual({
      limitations: ['legacy-spec-version-unbound', 'posw-not-recomputed'],
      keys: [],
    });
  });

  it('records no authority key when the binding stops before judging the key', async () => {
    // examProofVersion はハッシュの入力ではないので、書き換えても root は合ったまま束縛だけが手前で止まる
    const proof = loadFrozenProof('exam-v1');
    (proof.exam as unknown as Record<string, unknown>).examProofVersion = 2;
    const result = await verifyProofBySpec(
      proof,
      frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') })
    );
    expect({ limitations: result.limitations, keys: result.trust.keys }).toEqual({
      limitations: ['legacy-spec-version-unbound', 'posw-not-recomputed'],
      keys: [],
    });
  });

  it('fails the problem binding on the package of another exam', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v2') })
    );
    expect(result.checks.problemBinding).toEqual({ status: 'fail', code: 'exam-binding-invalid' });
  });

  it('reports a failed problem binding as failed integrity, as deriveAssurance does', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v2') })
    );
    expect(result.integrity).toBe('failed');
  });

  it('does not evaluate the acceptance policy when the problem binding failed', async () => {
    // legacy の verifyProofFile は束縛を知らないので、自分の policy を evaluated: true で返す
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v2') })
    );
    expect(result.acceptance).toEqual({
      applied: {
        requireRootAnchor: false,
        requireAnchorDensity: false,
        requireSignedCheckpoints: false,
        requireTerminalAnchor: false,
      },
      evaluated: false,
      violations: [],
    });
  });

  it('reports an authority key missing from the registry as unknown', async () => {
    const context = frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') });
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), {
      ...context,
      trust: { ...context.trust, examAuthorityKeys: [] },
    });
    expect(result.trust.keys).toEqual([
      {
        role: 'exam-authority',
        keyId: 'frozen-fixture-exam-0001',
        status: 'unknown',
        anchor: '2026-11-04T15:01:05.827Z',
      },
    ]);
  });

  it('fails the problem binding on an unknown authority key as untrusted', async () => {
    const context = frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') });
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), {
      ...context,
      trust: { ...context.trust, examAuthorityKeys: [] },
    });
    expect(result.checks.problemBinding).toEqual({ status: 'fail', code: 'exam-authority-key-untrusted' });
  });

  it('reports an authority key revoked after the release as trusted with a warning status', async () => {
    const context = frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') });
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), {
      ...context,
      trust: {
        ...context.trust,
        examAuthorityKeys: [{ ...frozenExamAuthorityKey(), status: 'revoked', revokedAt: '2027-01-01T00:00:00.000Z' }],
      },
    });
    expect(result.trust.keys.map((k) => k.status)).toEqual(['trusted-revoked-after-anchor']);
  });
});

describe('verifyProofBySpec: empty checkpoint key registry', () => {
  it('reports the token key and the checkpoint key as unknown', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), withCheckpointKeys([]));
    expect(result.trust.keys.map((k) => [k.role, k.keyId, k.status])).toEqual([
      ['session-token', 'frozen-fixture-checkpoint-0001', 'unknown'],
      ['checkpoint', 'frozen-fixture-checkpoint-0001', 'unknown'],
    ]);
  });

  it('does not pass the signed checkpoints signed by an unknown key', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), withCheckpointKeys([]));
    expect(result.checks.signedCheckpoints).toEqual({ status: 'fail', code: 'signed-checkpoint-key-untrusted' });
  });

  it('does not pass the session anchor carried by a token of an unknown key', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), withCheckpointKeys([]));
    expect(result.checks.sessionAnchor).toEqual({ status: 'fail', code: 'token-unknown-key' });
  });

  it('does not call an unknown key tampering', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), withCheckpointKeys([]));
    expect(result.integrity).toBe('partial');
  });

  it('does not evaluate the acceptance policy while the time evidence is untrusted', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), withCheckpointKeys([]));
    expect(result.acceptance.evaluated).toBe(false);
  });

  it('does not list a key whose id falls outside the allowed characters', async () => {
    const proof = loadFrozenProof('casual-anchored');
    proof.sessionStartToken!.keyId = 'bad key\nRoot anchor: VERIFIED';
    const result = await verifyProofBySpec(proof, withCheckpointKeys([]));
    expect(result.trust.keys[0]).toStrictEqual({
      role: 'session-token',
      status: 'unknown',
      anchor: '2026-11-04T16:01:02.810Z',
    });
  });

  it('does not list a key id that is not a string', async () => {
    const proof = loadFrozenProof('casual-anchored');
    (proof.sessionStartToken as unknown as Record<string, unknown>).keyId = 12345;
    const result = await verifyProofBySpec(proof, withCheckpointKeys([]));
    expect(result.trust.keys[0]).toStrictEqual({
      role: 'session-token',
      status: 'unknown',
      anchor: '2026-11-04T16:01:02.810Z',
    });
  });

  it('records no token key when the token is rejected before its key is looked up', async () => {
    const proof = loadFrozenProof('casual-anchored');
    (proof.sessionStartToken!.payload as unknown as Record<string, unknown>).version = 2;
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.trust.keys.map((k) => k.role)).toEqual(['checkpoint']);
  });
});

describe('verifyProofBySpec: checkpoint key revoked before the anchors', () => {
  it('reports the token key and the checkpoint key as revoked', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      withCheckpointKeys([revokedBeforeAnchors()])
    );
    expect(result.trust.keys.map((k) => [k.role, k.status])).toEqual([
      ['session-token', 'revoked'],
      ['checkpoint', 'revoked'],
    ]);
  });

  it('does not pass the signed checkpoints', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      withCheckpointKeys([revokedBeforeAnchors()])
    );
    expect(result.checks.signedCheckpoints).toEqual({ status: 'fail', code: 'signed-checkpoint-key-untrusted' });
  });

  it('does not pass the session anchor', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      withCheckpointKeys([revokedBeforeAnchors()])
    );
    expect(result.checks.sessionAnchor).toEqual({ status: 'fail', code: 'token-invalid' });
  });
});

describe('verifyProofBySpec: checkpoint key revoked after the anchors', () => {
  it('reports the token key and the checkpoint key as trusted but revoked after the anchor', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      withCheckpointKeys([revokedAfterAnchors()])
    );
    expect(result.trust.keys.map((k) => [k.role, k.status])).toEqual([
      ['session-token', 'trusted-revoked-after-anchor'],
      ['checkpoint', 'trusted-revoked-after-anchor'],
    ]);
  });

  it('still passes the signed checkpoints and the session anchor', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('casual-anchored'),
      withCheckpointKeys([revokedAfterAnchors()])
    );
    expect([result.checks.signedCheckpoints, result.checks.sessionAnchor]).toEqual([
      { status: 'pass' },
      { status: 'pass' },
    ]);
  });
});

describe('verifyProofBySpec: key anchors taken from the evidence', () => {
  it('normalizes the anchor to ISO 8601 instead of copying the self-reported string', async () => {
    // issuedAt は署名対象なので token は検証できなくなるが、鍵の判定 (issuedAt を anchor にする) までは進む
    const proof = loadFrozenProof('casual-anchored');
    proof.sessionStartToken!.payload.issuedAt = '2026-11-04T16:01:02.810+00:00';
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.trust.keys[0]).toEqual({
      role: 'session-token',
      keyId: 'frozen-fixture-checkpoint-0001',
      status: 'trusted',
      anchor: '2026-11-04T16:01:02.810Z',
    });
  });
});
