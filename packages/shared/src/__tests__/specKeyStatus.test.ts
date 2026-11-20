/**
 * 鍵の信頼状態を自由文の `reason` ではなく列挙型で返すことを固定する (#809)。
 *
 * 判定 (`checkRegistryKeyValidityAt`) は変えず、verdict を `RegistryKeyTrustStatus` に写す。署名 cp
 * (anchor = `serverTimestamp`)・sessionStartToken (`issuedAt`)・出題者鍵 (`releaseTime`) の 3 消費者が、
 * 判定の結果ごとに同じ値を返すことを凍結 proof と registry の差し替えで確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  checkRegistryKeyValidityAt,
  registryKeyTrustStatus,
  type RegistryKeyValidityFields,
} from '../checkpointKeys/keyValidity.js';
import {
  computeHash,
  verifyProofBySpec,
  type CheckpointPublicKey,
  type ExamAuthorityKey,
  type RegistryKeyTrustStatus,
} from '../index.js';
import {
  frozenCheckpointKey,
  frozenContext,
  frozenExamAuthorityKey,
  loadFrozenExamPackage,
  loadFrozenProof,
} from './fixtures/frozenProofFixtures.js';

/** registry のエントリの書き換え。全 anchor (2026-11-04) に対する結果がそれぞれの status になる */
const REGISTRY_VARIANTS: Array<{
  status: RegistryKeyTrustStatus;
  entry: Partial<RegistryKeyValidityFields>;
}> = [
  { status: 'trusted', entry: {} },
  { status: 'trusted-revoked-after-anchor', entry: { status: 'revoked', revokedAt: '2027-01-01T00:00:00.000Z' } },
  { status: 'revoked', entry: { status: 'revoked', revokedAt: '2026-01-02T00:00:00.000Z' } },
  { status: 'revoked', entry: { status: 'revoked' } },
  { status: 'expired', entry: { validUntil: '2026-01-02T00:00:00.000Z' } },
  { status: 'not-yet-valid', entry: { validFrom: '2027-01-01T00:00:00.000Z' } },
  { status: 'malformed-entry', entry: { validFrom: 'not a date' } },
  { status: 'malformed-entry', entry: { validUntil: 'not a date' } },
  { status: 'malformed-entry', entry: { revokedAt: 'not a date' } },
];

describe('registryKeyTrustStatus', () => {
  it.each(REGISTRY_VARIANTS)('maps the verdict for $entry to $status', ({ status, entry }) => {
    const verdict = checkRegistryKeyValidityAt(
      { keyId: 'k', status: 'active', validFrom: '2026-01-01T00:00:00.000Z', ...entry },
      Date.parse('2026-11-04T00:00:00.000Z')
    );
    expect(registryKeyTrustStatus(verdict)).toBe(status);
  });
});

describe('verifyProofBySpec key status of the session token and the signed checkpoints', () => {
  it.each(REGISTRY_VARIANTS)(
    'reports $status for both keys when the registry entry is $entry',
    async ({ status, entry }) => {
      const key = { ...frozenCheckpointKey(), ...entry } as CheckpointPublicKey;
      const context = frozenContext({ mode: 'fast' });
      const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), {
        ...context,
        trust: { ...context.trust, checkpointKeys: [key] },
      });
      expect(result.trust.keys.map((k) => [k.role, k.status])).toEqual([
        ['session-token', status],
        ['checkpoint', status],
      ]);
    }
  );

  it('keeps the token key status when the token signature is not valid hex', async () => {
    const proof = loadFrozenProof('casual-anchored');
    proof.sessionStartToken!.signature = 'abc';
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.trust.keys[0]).toMatchObject({ role: 'session-token', status: 'trusted' });
  });

  it.each(REGISTRY_VARIANTS.filter((v) => !v.status.startsWith('trusted')))(
    'fails the signed checkpoints as an untrusted key, not as tampering, when the key is $status ($entry)',
    async ({ entry }) => {
      const key = { ...frozenCheckpointKey(), ...entry } as CheckpointPublicKey;
      const context = frozenContext({ mode: 'fast' });
      const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), {
        ...context,
        trust: { ...context.trust, checkpointKeys: [key] },
      });
      expect([result.checks.signedCheckpoints, result.integrity]).toEqual([
        { status: 'fail', code: 'signed-checkpoint-key-untrusted' },
        'partial',
      ]);
    }
  );

  it('lists one entry per key status with the anchor of the last checkpoint in that status', async () => {
    // token (16:01:02.810) と 1・2 個目の cp (16:01:03.856 / 16:01:04.867) は期間内、3 個目 (16:01:05.869) は期限切れ
    const key = { ...frozenCheckpointKey(), validUntil: '2026-11-04T16:01:05.000Z' };
    const context = frozenContext({ mode: 'fast' });
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), {
      ...context,
      trust: { ...context.trust, checkpointKeys: [key] },
    });
    expect(result.trust.keys.filter((k) => k.role === 'checkpoint').map((k) => [k.status, k.anchor])).toEqual([
      ['trusted', '2026-11-04T16:01:04.867Z'],
      ['expired', '2026-11-04T16:01:05.869Z'],
    ]);
  });

  it('takes the checkpoint anchor from the signed checkpoints even when an unsigned one precedes them', async () => {
    const proof = loadFrozenProof('casual-anchored');
    const event = proof.proof.events[3]!;
    const contentHash = event.data
      ? await computeHash(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
      : '';
    proof.checkpoints!.unshift({ eventIndex: 3, hash: event.hash, timestamp: event.timestamp, contentHash });
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect({ checkpoints: result.checks.checkpoints, keys: result.trust.keys }).toEqual({
      checkpoints: { status: 'pass' },
      keys: [
        expect.objectContaining({ role: 'session-token' }),
        expect.objectContaining({ role: 'checkpoint', anchor: '2026-11-04T16:01:05.869Z' }),
      ],
    });
  });

  it('records no checkpoint key when the signature does not verify against a known key', async () => {
    const proof = loadFrozenProof('casual-anchored');
    const envelope = proof.checkpoints![0]!.signature!;
    envelope.signature = envelope.signature.slice(0, -1) + (envelope.signature.at(-1) === '0' ? '1' : '0');
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.trust.keys.map((k) => k.role)).toEqual(['session-token']);
  });
});

describe('verifyProofBySpec key status of the exam authority', () => {
  it.each(REGISTRY_VARIANTS)('reports $status when the registry entry is $entry', async ({ status, entry }) => {
    const key = { ...frozenExamAuthorityKey(), ...entry } as ExamAuthorityKey;
    const context = frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') });
    const result = await verifyProofBySpec(loadFrozenProof('exam-v1'), {
      ...context,
      trust: { ...context.trust, examAuthorityKeys: [key] },
    });
    expect(result.trust.keys.map((k) => [k.role, k.status])).toEqual([['exam-authority', status]]);
  });

  it('keeps the authority key status when the package signature is not hex', async () => {
    const manifest = loadFrozenExamPackage('exam-v1') as Record<string, unknown>;
    manifest.signature = 'zz';
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: manifest })
    );
    expect(result.trust.keys).toEqual([expect.objectContaining({ role: 'exam-authority', status: 'trusted' })]);
  });

  it('keeps the authority key status when the package signature does not verify', async () => {
    const manifest = loadFrozenExamPackage('exam-v1') as Record<string, string>;
    manifest.signature = manifest.signature!.slice(0, -1) + (manifest.signature!.at(-1) === '0' ? '1' : '0');
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      frozenContext({ mode: 'fast', examPackage: manifest })
    );
    expect(result.trust.keys).toEqual([expect.objectContaining({ role: 'exam-authority', status: 'trusted' })]);
  });
});
