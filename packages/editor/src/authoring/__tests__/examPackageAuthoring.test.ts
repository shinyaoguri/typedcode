import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeStartToken,
  computeExamPackageHash,
  decodeExamPlaintext,
  decryptExamPackage,
  verifyExamPackageSignature,
  type ExamAuthorityKey,
  type ExamPackageSigner,
} from '@typedcode/shared';
import {
  createExamPackage,
  createExamBundlePackage,
  formatProctorTokenForDisplay,
  generateProctorToken,
  importAuthoritySigner,
  type CreateExamPackageParams,
} from '../examPackageAuthoring.js';

const KEY_ID = 'exam-test-author';

/** ECDSA P-256 鍵を生成し、私的 JWK / 公開 JWK の両方を返す (出題者鍵の代理)。 */
async function generateAuthorityKeyPair(): Promise<{
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateJwk, publicJwk };
}

function baseParams(overrides: Partial<CreateExamPackageParams> = {}): CreateExamPackageParams {
  return {
    problemText: '# 問題1\n\n標準入力から2つの整数を読み、和を出力せよ。',
    examId: '2026-spring-cs101-final',
    problemId: 'p1',
    languages: ['c', 'python'],
    releaseTime: '2026-06-10T01:00:00.000Z',
    deadline: '2026-06-10T04:00:00.000Z',
    proctorToken: 'ABCD-EFGH',
    ...overrides,
  };
}

describe('generateProctorToken', () => {
  it('produces a token of the requested length using only Crockford Base32 characters', () => {
    const token = generateProctorToken(12);
    expect(token).toHaveLength(12);
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('defaults to 8 characters', () => {
    expect(generateProctorToken()).toHaveLength(8);
  });

  it('rejects a non-positive length', () => {
    expect(() => generateProctorToken(0)).toThrow();
    expect(() => generateProctorToken(-3)).toThrow();
  });
});

describe('formatProctorTokenForDisplay', () => {
  it('groups a canonicalized token into 4-character chunks for slide display', () => {
    expect(formatProctorTokenForDisplay('abcdefgh')).toBe('ABCD-EFGH');
  });

  it('leaves a chunk shorter than 4 without a trailing separator', () => {
    expect(formatProctorTokenForDisplay('ABCDEF')).toBe('ABCD-EF');
  });
});

describe('importAuthoritySigner', () => {
  it('imports a P-256 private JWK string into a signer without embedding the public key by default', async () => {
    const { privateJwk } = await generateAuthorityKeyPair();
    const signer = await importAuthoritySigner(JSON.stringify(privateJwk), KEY_ID);
    expect(signer.keyId).toBe(KEY_ID);
    expect(signer.publicKeyJwk).toBeUndefined();
  });

  it('embeds only the public components (no secret scalar d) when asked', async () => {
    const { privateJwk } = await generateAuthorityKeyPair();
    const signer = await importAuthoritySigner(privateJwk, KEY_ID, { embedPublicKey: true });
    expect(signer.publicKeyJwk).toBeDefined();
    expect(signer.publicKeyJwk).not.toHaveProperty('d');
    expect(signer.publicKeyJwk?.x).toBe(privateJwk.x);
    expect(signer.publicKeyJwk?.y).toBe(privateJwk.y);
  });

  it('rejects a JWK that is not an EC P-256 private key', async () => {
    const { publicJwk } = await generateAuthorityKeyPair();
    // public JWK has no "d" → not a signing key
    await expect(importAuthoritySigner(publicJwk, KEY_ID)).rejects.toThrow();
  });

  it('rejects malformed JSON', async () => {
    await expect(importAuthoritySigner('{not json', KEY_ID)).rejects.toThrow();
  });
});

describe('createExamPackage', () => {
  let signer: ExamPackageSigner;
  let registry: readonly ExamAuthorityKey[];

  beforeAll(async () => {
    const { privateJwk, publicJwk } = await generateAuthorityKeyPair();
    signer = await importAuthoritySigner(privateJwk, KEY_ID);
    registry = [
      {
        keyId: KEY_ID,
        algorithm: 'ECDSA-P256',
        publicKeyJwk: publicJwk,
        status: 'active',
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    ];
  });

  it('produces a manifest whose signature verifies against the authority registry', async () => {
    const { manifest } = await createExamPackage(baseParams(), signer);
    const result = await verifyExamPackageSignature(manifest, registry);
    expect(result.valid).toBe(true);
  });

  it('seals the problem so the proctor token decrypts back to the original plaintext', async () => {
    const params = baseParams();
    const { manifest, proctorToken } = await createExamPackage(params, signer);
    const decrypted = await decryptExamPackage(manifest, proctorToken);
    expect(decrypted.ok).toBe(true);
    expect(decrypted.ok && decrypted.plaintext).toBe(params.problemText);
  });

  it('returns the canonicalized proctor token actually used for KDF', async () => {
    const { proctorToken } = await createExamPackage(baseParams({ proctorToken: 'ab-cd-ef-gh' }), signer);
    expect(proctorToken).toBe(canonicalizeStartToken('ab-cd-ef-gh'));
  });

  it('reports a packageHash equal to the canonical hash recomputed from the manifest', async () => {
    const { manifest, packageHash } = await createExamPackage(baseParams(), signer);
    expect(packageHash).toBe(await computeExamPackageHash(manifest));
  });

  it('refuses to decrypt under a wrong proctor token', async () => {
    const { manifest } = await createExamPackage(baseParams({ proctorToken: 'CORRECT0' }), signer);
    const decrypted = await decryptExamPackage(manifest, 'WRONG000');
    expect(decrypted.ok).toBe(false);
  });

  it('trims and drops empty entries from the allowed languages', async () => {
    const { manifest } = await createExamPackage(baseParams({ languages: [' c ', '', 'python'] }), signer);
    expect(manifest.allowed.languages).toEqual(['c', 'python']);
  });

  it('uses a fresh random salt per package so two builds of the same input differ', async () => {
    const a = await createExamPackage(baseParams(), signer);
    const b = await createExamPackage(baseParams(), signer);
    expect(a.manifest.kdf.salt).not.toBe(b.manifest.kdf.salt);
    expect(a.packageHash).not.toBe(b.packageHash);
  });

  it('rejects an empty problem body', async () => {
    await expect(createExamPackage(baseParams({ problemText: '' }), signer)).rejects.toThrow();
  });

  it('rejects when no allowed language survives trimming', async () => {
    await expect(createExamPackage(baseParams({ languages: ['', '  '] }), signer)).rejects.toThrow();
  });

  it('rejects a release time that is not strictly before the deadline', async () => {
    await expect(
      createExamPackage(
        baseParams({ releaseTime: '2026-06-10T04:00:00.000Z', deadline: '2026-06-10T04:00:00.000Z' }),
        signer
      )
    ).rejects.toThrow();
  });

  it('rejects an unparseable release time', async () => {
    await expect(createExamPackage(baseParams({ releaseTime: 'not-a-date' }), signer)).rejects.toThrow();
  });

  it('rejects a proctor token with no Crockford characters', async () => {
    await expect(createExamPackage(baseParams({ proctorToken: '---' }), signer)).rejects.toThrow();
  });
});

describe('createExamBundlePackage', () => {
  let signer: ExamPackageSigner;
  let registry: readonly ExamAuthorityKey[];

  beforeAll(async () => {
    const { privateJwk, publicJwk } = await generateAuthorityKeyPair();
    signer = await importAuthoritySigner(privateJwk, KEY_ID);
    registry = [
      { keyId: KEY_ID, algorithm: 'ECDSA-P256', publicKeyJwk: publicJwk, status: 'active', validFrom: '2026-01-01T00:00:00.000Z' },
    ];
  });

  function bundleParams() {
    return {
      examId: '2026-spring-cs101-final',
      languages: ['c'],
      releaseTime: '2026-06-10T01:00:00.000Z',
      deadline: '2026-06-10T04:00:00.000Z',
      proctorToken: 'ABCD1234',
      problems: [
        { problemId: 'p1', statement: '# 問題1\n和を出力せよ。', starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' } },
        { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
      ],
    };
  }

  it('seals a tcexam-exam/1 bundle whose signature verifies against the registry', async () => {
    const { manifest } = await createExamBundlePackage(bundleParams(), signer);
    expect((await verifyExamPackageSignature(manifest, registry)).valid).toBe(true);
  });

  it('decrypts to a bundle payload with the authored problems and starter', async () => {
    const { manifest, proctorToken } = await createExamBundlePackage(bundleParams(), signer);
    const dec = await decryptExamPackage(manifest, proctorToken);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    const decoded = decodeExamPlaintext(dec.plaintext);
    expect(decoded.kind).toBe('bundle');
    if (decoded.kind !== 'bundle') return;
    expect(decoded.bundle.problems.map((p) => p.problemId)).toEqual(['p1', 'p2']);
    expect(decoded.bundle.problems[0]!.starter?.content).toBe('/* TODO */\n');
    expect(decoded.bundle.problems[1]!.starter).toBeUndefined();
  });

  it('labels the manifest problemId as "bundle" (per-problem ids live in the payload)', async () => {
    const { manifest } = await createExamBundlePackage(bundleParams(), signer);
    expect(manifest.problemId).toBe('bundle');
  });

  it('rejects an empty problem list', async () => {
    await expect(createExamBundlePackage({ ...bundleParams(), problems: [] }, signer)).rejects.toThrow();
  });

  it('rejects duplicate problemIds', async () => {
    const dup = { ...bundleParams(), problems: [
      { problemId: 'p1', statement: 'a' },
      { problemId: 'p1', statement: 'b' },
    ] };
    await expect(createExamBundlePackage(dup, signer)).rejects.toThrow();
  });

  it('rejects a problem with an empty statement', async () => {
    const bad = { ...bundleParams(), problems: [{ problemId: 'p1', statement: '   ' }] };
    await expect(createExamBundlePackage(bad, signer)).rejects.toThrow();
  });
});
