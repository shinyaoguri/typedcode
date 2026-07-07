/**
 * ADR-0006 試験モードのテスト用フィクスチャ。
 *
 * テストでは Argon2id を**極小パラメータ** (256 KiB / 1 iter) にして高速化する
 * (暗号の正しさは params に非依存。本番既定の 64 MiB はパッケージ author が設定する)。
 */

import {
  buildExamPackage,
  type ExamPackageBuildInput,
  type ExamPackageManifest,
  type ExamPackageSigner,
} from '../../index.js';
import type { ExamAuthorityKey } from '../../examAuthorityKeys/index.js';

/** テスト用の高速 KDF パラメータ */
export const FAST_KDF_PARAMS = { memKiB: 256, iterations: 1, parallelism: 1 } as const;

export interface ExamAuthorityFixture {
  signer: ExamPackageSigner;
  entry: ExamAuthorityKey;
  registry: readonly ExamAuthorityKey[];
}

/** ECDSA-P256 の出題者鍵ペアを生成し、registry エントリと signer を返す */
export async function makeExamAuthority(keyId = 'exam-test-0001'): Promise<ExamAuthorityFixture> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const entry: ExamAuthorityKey = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk,
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
  };
  const signer: ExamPackageSigner = { keyId, privateKey: pair.privateKey, publicKeyJwk };
  return { signer, entry, registry: [entry] };
}

export interface SamplePackageOptions {
  token?: string;
  plaintext?: string;
  examId?: string;
  problemId?: string;
  variant?: string | null;
  /** signer.publicKeyJwk を同梱するか */
  embedPubkey?: boolean;
  releaseTime?: string;
  deadline?: string;
}

/** テスト用の封印問題パッケージを 1 つ作る */
export async function buildSamplePackage(
  signer: ExamPackageSigner,
  opts: SamplePackageOptions = {}
): Promise<{ manifest: ExamPackageManifest; token: string; plaintext: string }> {
  const token = opts.token ?? 'ABCD1234';
  const plaintext = opts.plaintext ?? '# Problem 1\nWrite a program that prints 42.';
  const input: ExamPackageBuildInput = {
    formatVersion: 1,
    examId: opts.examId ?? 'exam-1',
    problemId: opts.problemId ?? 'p1',
    variant: opts.variant ?? null,
    kdf: { algorithm: 'argon2id', salt: 'ab'.repeat(16), params: { ...FAST_KDF_PARAMS } },
    releaseTime: opts.releaseTime ?? '2026-06-06T00:00:00.000Z',
    deadline: opts.deadline ?? '2026-06-06T03:00:00.000Z',
    allowed: { languages: ['c'] },
    keyId: signer.keyId,
    algorithm: 'ECDSA-P256',
  };
  const buildSigner: ExamPackageSigner = opts.embedPubkey
    ? signer
    : { keyId: signer.keyId, privateKey: signer.privateKey };
  const manifest = await buildExamPackage(input, plaintext, token, buildSigner);
  return { manifest, token, plaintext };
}
