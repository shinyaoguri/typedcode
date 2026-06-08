/**
 * ADR-0006 試験モードの暗号コアのテスト。
 *
 * 封印問題パッケージの build → 署名検証 → 復号の往復、canonical hash の決定性、
 * チェーン根束縛、HashChainManager とのパリティ、出題者鍵レジストリ、version 定数を保証する。
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalizeStartToken,
  parseExamPackageManifest,
  examPackageSigningCore,
  computeExamPackageHash,
  computeProblemContentHash,
  computeExamChainRoot,
  decryptExamPackage,
  verifyExamPackageSignature,
  findExamAuthorityKey,
  computeHash,
  deterministicStringify,
  PROOF_FORMAT_VERSION,
  EXAM_PACKAGE_FORMAT_VERSION,
  EXAM_PROOF_VERSION,
  EXAM_ROOT_BINDING,
} from '../index.js';
import { HashChainManager } from '../typingProof/HashChainManager.js';
// 本番レジストリ (registry.ts) を直接見る。`index.js` 経由の merged 版は各開発者の
// localKeys (skip-worktree) を含み得るため、本番鍵の空判定にはこちらを使う。
import { EXAM_AUTHORITY_KEYS as PRODUCTION_EXAM_AUTHORITY_KEYS } from '../examAuthorityKeys/registry.js';
import { makeExamAuthority, buildSamplePackage } from './fixtures/examFixtures.js';

describe('canonicalizeStartToken', () => {
  it('uppercases and strips grouping separators to a canonical token', () => {
    expect(canonicalizeStartToken('abcd-efgh')).toBe('ABCDEFGH');
  });

  it('removes spaces and characters outside the Crockford alphabet', () => {
    expect(canonicalizeStartToken(' ab cd 12 34 ')).toBe('ABCD1234');
  });
});

describe('parseExamPackageManifest', () => {
  it('accepts a well-formed manifest and returns it', async () => {
    const { signer } = await makeExamAuthority('exam-parse-ok');
    const { manifest } = await buildSamplePackage(signer);
    const parsed = parseExamPackageManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(manifest.keyId);
  });

  it('rejects non-objects', () => {
    expect(parseExamPackageManifest(null)).toBeNull();
    expect(parseExamPackageManifest('{}')).toBeNull();
    expect(parseExamPackageManifest(42)).toBeNull();
    expect(parseExamPackageManifest([])).toBeNull();
  });

  it('rejects manifests missing required string fields', async () => {
    const { signer } = await makeExamAuthority('exam-parse-missing');
    const { manifest } = await buildSamplePackage(signer);
    for (const field of ['examId', 'problemId', 'keyId', 'algorithm', 'signature', 'releaseTime']) {
      const broken: Record<string, unknown> = { ...manifest };
      delete broken[field];
      expect(parseExamPackageManifest(broken)).toBeNull();
    }
  });

  it('rejects malformed kdf / cipher / allowed blocks', async () => {
    const { signer } = await makeExamAuthority('exam-parse-blocks');
    const { manifest } = await buildSamplePackage(signer);
    expect(parseExamPackageManifest({ ...manifest, kdf: { algorithm: 'pbkdf2' } })).toBeNull();
    expect(parseExamPackageManifest({ ...manifest, cipher: { algorithm: 'AES-128-CBC' } })).toBeNull();
    expect(parseExamPackageManifest({ ...manifest, allowed: { languages: 'c' } })).toBeNull();
    expect(
      parseExamPackageManifest({ ...manifest, kdf: { ...manifest.kdf, params: { memKiB: 1 } } })
    ).toBeNull();
  });

  it('accepts a null variant but rejects a non-string non-null variant', async () => {
    const { signer } = await makeExamAuthority('exam-parse-variant');
    const { manifest } = await buildSamplePackage(signer);
    expect(parseExamPackageManifest({ ...manifest, variant: null })).not.toBeNull();
    expect(parseExamPackageManifest({ ...manifest, variant: 7 })).toBeNull();
  });
});

describe('exam package signature', () => {
  it('verifies a freshly built package against the authority registry', async () => {
    const { signer, registry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer);

    const result = await verifyExamPackageSignature(manifest, registry);
    expect(result.valid).toBe(true);
  });

  it('rejects a package whose signed-core field was tampered', async () => {
    const { signer, registry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer);

    const tampered = { ...manifest, examId: 'different-exam' };
    const result = await verifyExamPackageSignature(tampered, registry);
    expect(result.valid).toBe(false);
  });

  it('rejects a package whose ciphertext was tampered', async () => {
    const { signer, registry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer);

    const tampered = {
      ...manifest,
      cipher: { ...manifest.cipher, ciphertext: btoa('not the real ciphertext') },
    };
    const result = await verifyExamPackageSignature(tampered, registry);
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown keyId when no embedded public key is present', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer); // not embedding pubkey

    const result = await verifyExamPackageSignature(manifest, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown keyId');
  });

  it('does not trust an embedded public key whose keyId is absent from the registry (no self-cert)', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer, { embedPubkey: true });

    // 埋め込み鍵は信頼の源ではない。registry 未登録の keyId は untrusted で弾く
    // (さもないと攻撃者が自分の鍵を同梱して自己署名できてしまう)。
    const result = await verifyExamPackageSignature(manifest, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown keyId');
  });

  it('rejects when the embedded public key disagrees with the registry entry', async () => {
    const a = await makeExamAuthority('exam-shared-id');
    const b = await makeExamAuthority('exam-shared-id'); // different key, same keyId
    const { manifest } = await buildSamplePackage(a.signer, { embedPubkey: true });

    // registry has b's key under the same keyId -> embedded (a) must not match
    const result = await verifyExamPackageSignature(manifest, b.registry);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match registry');
  });

  it('rejects a package whose releaseTime is after the key validUntil (expired)', async () => {
    const { signer, entry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer); // releaseTime 2026-06-06
    const expired = [{ ...entry, validUntil: '2026-03-01T00:00:00.000Z' }];
    const result = await verifyExamPackageSignature(manifest, expired);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('rejects a package whose releaseTime precedes the key validFrom', async () => {
    const { signer, entry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer); // releaseTime 2026-06-06
    const future = [{ ...entry, validFrom: '2026-09-01T00:00:00.000Z' }];
    const result = await verifyExamPackageSignature(manifest, future);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not yet valid');
  });

  it('rejects a revoked key that has no revokedAt', async () => {
    const { signer, entry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer);
    const revoked = [{ ...entry, status: 'revoked' as const }];
    const result = await verifyExamPackageSignature(manifest, revoked);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('rejects a package released at or after the key revokedAt', async () => {
    const { signer, entry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer); // releaseTime 2026-06-06
    const revoked = [{ ...entry, status: 'revoked' as const, revokedAt: '2026-03-01T00:00:00.000Z' }];
    const result = await verifyExamPackageSignature(manifest, revoked);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('trusts a package released before revokedAt but surfaces a warning', async () => {
    const { signer, entry } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer); // releaseTime 2026-06-06
    const revoked = [{ ...entry, status: 'revoked' as const, revokedAt: '2026-09-01T00:00:00.000Z' }];
    const result = await verifyExamPackageSignature(manifest, revoked);
    expect(result.valid).toBe(true);
    expect(result.warning).toContain('revoked after');
  });
});

describe('exam package decryption', () => {
  it('decrypts to the original plaintext with the correct proctor code', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest, token, plaintext } = await buildSamplePackage(signer);

    const result = await decryptExamPackage(manifest, token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plaintext).toBe(plaintext);
  });

  it('fails (GCM auth tag) with a wrong proctor code', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer, { token: 'ABCD1234' });

    const result = await decryptExamPackage(manifest, 'WRONG999');
    expect(result.ok).toBe(false);
  });
});

describe('canonical package hash', () => {
  it('is deterministic and equals the signed-core SHA-256', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer);

    const h1 = await computeExamPackageHash(manifest);
    const h2 = await computeExamPackageHash(manifest);
    const manual = await computeHash(deterministicStringify(examPackageSigningCore(manifest)));

    expect(h1).toBe(h2);
    expect(h1).toBe(manual);
  });

  it('ignores the optional embedded publicKeyJwk (same hash with/without)', async () => {
    const { signer } = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(signer, { embedPubkey: true });

    const withKey = await computeExamPackageHash(manifest);
    const { publicKeyJwk: _omit, ...withoutKey } = manifest;
    const without = await computeExamPackageHash(withoutKey);
    expect(withKey).toBe(without);
  });
});

describe('exam chain root', () => {
  const fp = 'f'.repeat(64);
  const nonce = '1'.repeat(64);
  const pkgHash = 'a'.repeat(64);
  const token = 'ABCD1234';

  it('is deterministic for the same inputs', async () => {
    const r1 = await computeExamChainRoot(fp, nonce, pkgHash, token);
    const r2 = await computeExamChainRoot(fp, nonce, pkgHash, token);
    expect(r1).toBe(r2);
  });

  it('differs from the casual root (fingerprint + nonce only)', async () => {
    const examRoot = await computeExamChainRoot(fp, nonce, pkgHash, token);
    const casualRoot = await computeHash(fp + nonce);
    expect(examRoot).not.toBe(casualRoot);
  });

  it('changes when the proctor code changes', async () => {
    const a = await computeExamChainRoot(fp, nonce, pkgHash, 'ABCD1234');
    const b = await computeExamChainRoot(fp, nonce, pkgHash, 'ABCD1235');
    expect(a).not.toBe(b);
  });

  it('matches HashChainManager.generateExamInitialHash for its nonce', async () => {
    const hcm = new HashChainManager();
    const initial = await hcm.generateExamInitialHash(fp, pkgHash, token);
    const expected = await computeExamChainRoot(fp, initial.nonce, pkgHash, token);
    expect(initial.hash).toBe(expected);
  });

  it('matches generateExamInitialHash for v2 (per-problem hash) — editor genesis ↔ grader root', async () => {
    const pch = 'd'.repeat(64);
    const hcm = new HashChainManager();
    const initial = await hcm.generateExamInitialHash(fp, pkgHash, token, pch);
    const expected = await computeExamChainRoot(fp, initial.nonce, pkgHash, token, pch);
    expect(initial.hash).toBe(expected);
  });
});

describe('problem content hash', () => {
  it('is the SHA-256 of the plaintext', async () => {
    const text = 'hello exam';
    expect(await computeProblemContentHash(text)).toBe(await computeHash(text));
  });
});

describe('exam authority registry', () => {
  it('finds a key by id in an injected registry', async () => {
    const { entry, registry } = await makeExamAuthority('exam-lookup-1');
    expect(findExamAuthorityKey('exam-lookup-1', registry)).toBe(entry);
  });

  it('returns undefined for an unknown key id', () => {
    expect(findExamAuthorityKey('does-not-exist', [])).toBeUndefined();
  });

  it('ships no keys in the production registry until a real exam key is onboarded', () => {
    // localKeys (dev) は除外。本番 registry.ts のみを検査する (誤って dev/preview 鍵を commit した検出)。
    // dev/preview 検証鍵は localKeys.ts に置く規約なので、本番 registry は実鍵オンボードまで空。
    expect(PRODUCTION_EXAM_AUTHORITY_KEYS.map((k) => k.keyId)).toEqual([]);
  });
});

describe('exam version constants', () => {
  it('bumps the proof format version to 1.1.0 for the exam root change', () => {
    expect(PROOF_FORMAT_VERSION).toBe('1.1.0');
  });

  it('exposes the exam package/proof/root-binding versions', () => {
    expect(EXAM_PACKAGE_FORMAT_VERSION).toBe(1);
    expect(EXAM_PROOF_VERSION).toBe(1);
    expect(EXAM_ROOT_BINDING).toBe('v1');
  });
});
