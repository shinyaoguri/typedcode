import { describe, expect, it } from 'vitest';
import { verifyExamPackageSignature, type ExamAuthorityKey } from '@typedcode/shared';
import { generateAuthorityKey, suggestKeyId } from '../authorityKey.js';
import { createExamPackage, importAuthoritySigner } from '../examPackageAuthoring.js';

describe('suggestKeyId', () => {
  it('formats as exam-YYYYMM-xxxxxx from the given date and random hex', () => {
    expect(suggestKeyId(new Date('2026-06-08T12:00:00Z'), 'ab12cd')).toBe('exam-202606-ab12cd');
  });

  it('lowercases and truncates the random suffix to 6 hex characters', () => {
    expect(suggestKeyId(new Date('2026-01-01T00:00:00Z'), 'AB12CDEF99')).toBe('exam-202601-ab12cd');
  });
});

describe('generateAuthorityKey', () => {
  it('produces a private JWK with a secret scalar and a public JWK without one', async () => {
    const key = await generateAuthorityKey();
    expect(key.privateJwk.kty).toBe('EC');
    expect(key.privateJwk.crv).toBe('P-256');
    expect(key.privateJwk.d).toBeTruthy();
    expect(key.publicJwk.d).toBeUndefined();
  });

  it('honors an explicit keyId override', async () => {
    const key = await generateAuthorityKey({ keyId: 'exam-2026s-final1' });
    expect(key.keyId).toBe('exam-2026s-final1');
    expect(key.registryEntry.keyId).toBe('exam-2026s-final1');
  });

  it('builds a registry entry that is active from the generation time', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const key = await generateAuthorityKey({ now });
    expect(key.registryEntry.status).toBe('active');
    expect(key.registryEntry.algorithm).toBe('ECDSA-P256');
    expect(key.registryEntry.validFrom).toBe('2026-06-08T00:00:00.000Z');
  });

  it('yields a key pair that actually signs a verifiable package end to end', async () => {
    // 鍵の validFrom は package の releaseTime **以前**でなければ、署名は正しくても
    // checkExamKeyValidityAtRelease が「release 時点で鍵が未有効」として弾く (ADR-0006 の硬化)。
    // `now` を固定し validFrom を releaseTime より前に置く (実時計に依存しない決定的テストにする)。
    const key = await generateAuthorityKey({
      keyId: 'exam-test-e2e',
      now: new Date('2026-06-10T00:00:00.000Z'),
    });
    const signer = await importAuthoritySigner(key.privateJwk, key.keyId);
    const { manifest } = await createExamPackage(
      {
        problemText: 'hello',
        examId: 'e',
        problemId: 'p1',
        languages: ['c'],
        releaseTime: '2026-06-10T01:00:00.000Z',
        deadline: '2026-06-10T04:00:00.000Z',
        proctorToken: 'ABCD1234',
      },
      signer
    );
    const registry: readonly ExamAuthorityKey[] = [key.registryEntry];
    const result = await verifyExamPackageSignature(manifest, registry);
    expect(result.valid).toBe(true);
  });
});
