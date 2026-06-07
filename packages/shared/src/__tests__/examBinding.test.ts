/**
 * ADR-0006 試験モードの束縛検証テスト。
 *
 * - verifyInitialHashRoot が `proof.exam` の有無で root 式を分岐する
 * - verifyExamBinding が grader フロー (署名 → packageHash → root → 内容ハッシュ → time-box) を通す
 */

import { describe, expect, it } from 'vitest';
import {
  verifyInitialHashRoot,
  verifyExamBinding,
  buildExamProofBlock,
  computeExamPackageHash,
  computeProblemContentHash,
  computeExamChainRoot,
  computeHash,
  deterministicStringify,
  type ExamPackageManifest,
  type ExamProofBlock,
  type ExamAuthorityKey,
} from '../index.js';
import {
  makeExamAuthority,
  buildSamplePackage,
  type SamplePackageOptions,
  type ExamAuthorityFixture,
} from './fixtures/examFixtures.js';

interface FabricatedExamProof {
  typingProofData: { deviceId: string; initialHashNonce: string; initialEventChainHash: string };
  proof: { events: Array<{ previousHash: string }>; finalHash: string };
  fingerprint: { hash: string; components: Record<string, string> };
  exam: ExamProofBlock;
}

interface ExamProofFixture {
  proof: FabricatedExamProof;
  manifest: ExamPackageManifest;
  registry: readonly ExamAuthorityKey[];
  signer: ExamAuthorityFixture['signer'];
  token: string;
}

/** 整合した exam proof (root が package+token に束縛されている) と manifest を捏造する */
async function makeExamProof(opts: SamplePackageOptions = {}): Promise<ExamProofFixture> {
  const { signer, registry } = await makeExamAuthority();
  const { manifest, token, plaintext } = await buildSamplePackage(signer, opts);

  const packageHash = await computeExamPackageHash(manifest);
  const problemContentHash = await computeProblemContentHash(plaintext);

  const components = { lang: 'en-US', tz: 'UTC' };
  const fpHash = await computeHash(deterministicStringify(components));
  const nonce = '7'.repeat(64);
  const root = await computeExamChainRoot(fpHash, nonce, packageHash, token);

  const exam = buildExamProofBlock({
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    packageHash,
    problemContentHash,
    startToken: token,
  });

  const proof: FabricatedExamProof = {
    typingProofData: { deviceId: fpHash, initialHashNonce: nonce, initialEventChainHash: root },
    proof: { events: [{ previousHash: root }], finalHash: root },
    fingerprint: { hash: fpHash, components },
    exam,
  };
  return { proof, manifest, registry, signer, token };
}

type RootArg = Parameters<typeof verifyInitialHashRoot>[0];
type BindingArg = Parameters<typeof verifyExamBinding>[0];

describe('verifyInitialHashRoot (exam branch)', () => {
  it('accepts an exam proof whose root is bound to packageHash + startToken', async () => {
    const { proof } = await makeExamProof();
    const result = await verifyInitialHashRoot(proof as unknown as RootArg);
    expect(result.valid).toBe(true);
  });

  it('rejects the same proof when the exam block is absent (casual root formula no longer matches)', async () => {
    const { proof } = await makeExamProof();
    const { exam: _exam, ...casual } = proof;
    const result = await verifyInitialHashRoot(casual as unknown as RootArg);
    expect(result.valid).toBe(false);
  });

  it('rejects an exam proof whose startToken was altered in the block', async () => {
    const { proof } = await makeExamProof();
    const altered = { ...proof, exam: { ...proof.exam, startToken: 'ZZZZ9999' } };
    const result = await verifyInitialHashRoot(altered as unknown as RootArg);
    expect(result.valid).toBe(false);
  });
});

describe('verifyExamBinding', () => {
  it('passes all steps for a consistent proof + package', async () => {
    const { proof, manifest, registry } = await makeExamProof();
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.packageSignatureValid).toBe(true);
    expect(result.packageHashMatches).toBe(true);
    expect(result.rootMatches).toBe(true);
    expect(result.problemContentHashMatches).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.timeBox?.windowCoherent).toBe(true);
    expect(result.timeBox?.withinWindow).toBeNull();
  });

  it('reports withinWindow true for a submission inside the time-box', async () => {
    const { proof, manifest, registry } = await makeExamProof();
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
      submissionTimeMs: Date.parse('2026-06-06T01:00:00.000Z'),
    });
    expect(result.timeBox?.withinWindow).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('fails when the submission is after the deadline', async () => {
    const { proof, manifest, registry } = await makeExamProof();
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
      submissionTimeMs: Date.parse('2026-06-06T09:00:00.000Z'),
    });
    expect(result.timeBox?.withinWindow).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('fails when the package signature cannot be verified (unknown authority)', async () => {
    const { proof, manifest } = await makeExamProof();
    const result = await verifyExamBinding(proof as unknown as BindingArg, manifest, {
      examAuthorityRegistry: [],
    });
    expect(result.packageSignatureValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('fails when the decrypted content hash does not match the proof block', async () => {
    const { proof, manifest, registry } = await makeExamProof();
    const broken = { ...proof, exam: { ...proof.exam, problemContentHash: 'd'.repeat(64) } };
    const result = await verifyExamBinding(broken as unknown as BindingArg, manifest, {
      examAuthorityRegistry: registry,
    });
    expect(result.problemContentHashMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('fails when a validly-signed package does not match the bound packageHash', async () => {
    const { proof, registry, signer } = await makeExamProof();
    // 同じ出題者鍵で署名されているが内容が違う package (異なる packageHash) を grader に渡す
    const other = await buildSamplePackage(signer, { plaintext: 'totally different problem' });
    const result = await verifyExamBinding(proof as unknown as BindingArg, other.manifest, {
      examAuthorityRegistry: registry,
    });
    // 署名は registry の鍵で通るが、packageHash が proof.exam.packageHash と一致しない
    expect(result.packageSignatureValid).toBe(true);
    expect(result.packageHashMatches).toBe(false);
    expect(result.valid).toBe(false);
  });
});
