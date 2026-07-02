/**
 * ADR-0012 (N問バンドル + B-2 root) の grader 検証テスト。
 *
 * - verifyExamBinding が v2 proof を「署名 → packageHash → root(v2) → per-problem 内容ハッシュ」で通す
 * - verifyInitialHashRoot が v2 root (末尾に problemContentHash を連結) を受理する
 * - 問題ラベル付け替え / v2 主張だが平文が非バンドル / 未知 problemId を弾く
 */

import { describe, expect, it } from 'vitest';
import {
  verifyInitialHashRoot,
  verifyExamBinding,
  buildExamProofBlock,
  computeExamPackageHash,
  computeExamChainRoot,
  computeBundleProblemHash,
  encodeExamBundle,
  EXAM_BUNDLE_SCHEMA,
  EXAM_ROOT_BINDING_V2,
  computeHash,
  deterministicStringify,
  type ExamBundle,
  type ExamPackageManifest,
  type ExamProofBlock,
  type ExamAuthorityKey,
} from '../index.js';
import { makeExamAuthority, buildSamplePackage } from './fixtures/examFixtures.js';

interface FabricatedExamProof {
  typingProofData: { deviceId: string; initialHashNonce: string; initialEventChainHash: string };
  proof: { events: Array<{ previousHash: string }>; finalHash: string };
  fingerprint: { hash: string; components: Record<string, string> };
  exam: ExamProofBlock;
}

type BindingArg = Parameters<typeof verifyExamBinding>[0];
type RootArg = Parameters<typeof verifyInitialHashRoot>[0];

function sampleBundle(): ExamBundle {
  return {
    schema: EXAM_BUNDLE_SCHEMA,
    problems: [
      { problemId: 'p1', statement: '# 問題1\n和を出力せよ。', starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' } },
      { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
    ],
  };
}

interface BundleProofFixture {
  proof: FabricatedExamProof;
  manifest: ExamPackageManifest;
  registry: readonly ExamAuthorityKey[];
}

/**
 * 1つのバンドルパッケージを封印し、その中の problemIndex 番目の問題に束縛した v2 proof を捏造する
 * (= その問題のタブの proof に相当)。
 */
async function makeBundleProof(
  problemIndex: number,
  overrides: { problemIdInBlock?: string; bundle?: ExamBundle } = {}
): Promise<BundleProofFixture> {
  const { signer, registry } = await makeExamAuthority();
  const bundle = overrides.bundle ?? sampleBundle();
  const { manifest, token } = await buildSamplePackage(signer, { plaintext: encodeExamBundle(bundle) });

  const packageHash = await computeExamPackageHash(manifest);
  const problem = bundle.problems[problemIndex]!;
  const problemContentHash = await computeBundleProblemHash(problem);

  const components = { lang: 'en-US', tz: 'UTC' };
  const fpHash = await computeHash(deterministicStringify(components));
  const nonce = '7'.repeat(64);
  // v2 root: 末尾に per-problem ハッシュを連結。
  const root = await computeExamChainRoot(fpHash, nonce, packageHash, token, problemContentHash);

  const exam: ExamProofBlock = {
    ...buildExamProofBlock({
      examId: manifest.examId,
      problemId: overrides.problemIdInBlock ?? problem.problemId,
      variant: manifest.variant,
      packageHash,
      problemContentHash,
      startToken: token,
    }),
    rootBinding: EXAM_ROOT_BINDING_V2,
  };

  const proof: FabricatedExamProof = {
    typingProofData: { deviceId: fpHash, initialHashNonce: nonce, initialEventChainHash: root },
    proof: { events: [{ previousHash: root }], finalHash: root },
    fingerprint: { hash: fpHash, components },
    exam,
  };
  return { proof, manifest, registry };
}

describe('verifyInitialHashRoot (v2 bundle branch)', () => {
  it('accepts a v2 root bound to packageHash + startToken + per-problem hash', async () => {
    const { proof } = await makeBundleProof(0);
    const result = await verifyInitialHashRoot(proof as unknown as RootArg);
    expect(result.valid).toBe(true);
  });

  it('rejects a v2 proof whose per-problem hash in the block was altered (root no longer matches)', async () => {
    const { proof } = await makeBundleProof(0);
    const altered = { ...proof, exam: { ...proof.exam, problemContentHash: 'f'.repeat(64) } };
    const result = await verifyInitialHashRoot(altered as unknown as RootArg);
    expect(result.valid).toBe(false);
  });
});

describe('verifyExamBinding (v2 bundle)', () => {
  it('passes every step for a consistent v2 bundle proof bound to one problem', async () => {
    const { proof, manifest, registry } = await makeBundleProof(0);
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.packageSignatureValid).toBe(true);
    expect(result.packageHashMatches).toBe(true);
    expect(result.rootMatches).toBe(true);
    expect(result.problemContentHashMatches).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('verifies the second problem of the same bundle independently', async () => {
    const { proof, manifest, registry } = await makeBundleProof(1);
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a proof whose block problemId does not exist in the bundle', async () => {
    // root は p1 のハッシュで作るが block の problemId を未知 idに差し替える → 内容照合で fail。
    const { proof, manifest, registry } = await makeBundleProof(0, { problemIdInBlock: 'does-not-exist' });
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does-not-exist');
  });

  it('rejects a v1-claiming proof over a bundle-sealed package (downgrade forgery)', async () => {
    // バンドル封印 package に対し rootBinding 未設定 (v1) の proof を捏造する:
    // problemContentHash = 平文全体ハッシュ、root = v1 式。#137 のダウングレード攻撃。
    const { signer, registry } = await makeExamAuthority();
    const bundle = sampleBundle();
    const plaintext = encodeExamBundle(bundle);
    const { manifest, token } = await buildSamplePackage(signer, { plaintext });
    const packageHash = await computeExamPackageHash(manifest);
    // v1 経路の内容ハッシュ = 平文全体の SHA-256 を proof に自己申告する。
    const wholePlaintextHash = await computeHash(plaintext);
    const components = { lang: 'en-US', tz: 'UTC' };
    const fpHash = await computeHash(deterministicStringify(components));
    const nonce = '7'.repeat(64);
    // v1 root: per-problem ハッシュを連結しない。
    const root = await computeExamChainRoot(fpHash, nonce, packageHash, token);
    const exam: ExamProofBlock = buildExamProofBlock({
      examId: manifest.examId, problemId: 'anything-i-like', variant: null,
      packageHash, problemContentHash: wholePlaintextHash, startToken: token,
    });
    const proof = {
      typingProofData: { deviceId: fpHash, initialHashNonce: nonce, initialEventChainHash: root },
      proof: { events: [{ previousHash: root }], finalHash: root },
      fingerprint: { hash: fpHash, components },
      exam,
    };
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('must use v2');
  });

  it('rejects a v2 proof when the decrypted plaintext is not a bundle (legacy markdown)', async () => {
    // 平文を生 markdown にして封印するが、proof は v2 を主張する。
    const { signer, registry } = await makeExamAuthority();
    const { manifest, token } = await buildSamplePackage(signer, { plaintext: '# 生 markdown 問題' });
    const packageHash = await computeExamPackageHash(manifest);
    const fakeProblemHash = 'a'.repeat(64);
    const components = { lang: 'en-US', tz: 'UTC' };
    const fpHash = await computeHash(deterministicStringify(components));
    const nonce = '7'.repeat(64);
    const root = await computeExamChainRoot(fpHash, nonce, packageHash, token, fakeProblemHash);
    const exam: ExamProofBlock = {
      ...buildExamProofBlock({
        examId: manifest.examId, problemId: 'p1', variant: null,
        packageHash, problemContentHash: fakeProblemHash, startToken: token,
      }),
      rootBinding: EXAM_ROOT_BINDING_V2,
    };
    const proof = {
      typingProofData: { deviceId: fpHash, initialHashNonce: nonce, initialEventChainHash: root },
      proof: { events: [{ previousHash: root }], finalHash: root },
      fingerprint: { hash: fpHash, components },
      exam,
    };
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not an exam bundle');
  });
});
