/**
 * exam の識別子 (examId / problemId / variant) は、束縛が検証済みのときだけ manifest の値を載せる (#273)。
 *
 * proof.exam の識別子は proof 側の自己申告で、暗号的束縛 (packageHash / root / 内容ハッシュ) の外にある。
 * `verifyProof` は束縛合格時のみ署名済み manifest の値を `exam` に載せ、それ以外 (package 未提供・
 * 束縛失敗) は自己申告値のまま `identifiersVerified: false` で区別する。表示側
 * (`output.ts` の `(self-reported)`) はこのフラグだけを見る。
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExamAuthorityKey, ExamPackageManifest, ExamProofBlock } from '@typedcode/shared';

// verify.ts は組み込みの出題者鍵 registry (EXAM_AUTHORITY_KEYS) で署名を検証する。テストでは使い捨ての
// 鍵を registry に差し込む (配列を mutate するので mock の factory からは同じ参照を返す)。
const { testRegistry } = vi.hoisted(() => ({ testRegistry: [] as unknown[] }));
vi.mock('@typedcode/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typedcode/shared')>();
  return { ...actual, EXAM_AUTHORITY_KEYS: testRegistry };
});

import {
  buildExamPackage,
  buildExamProofBlock,
  computeExamChainRoot,
  computeExamPackageHash,
  computeHash,
  computeProblemContentHash,
  deterministicStringify,
} from '@typedcode/shared';
import { verifyProof, type ProofFile } from '../verify.js';
import { formatResult } from '../output.js';

const TOKEN = 'ABCD1234';
const PLAINTEXT = '# Problem 1\nWrite a program that prints 42.';

let manifest: ExamPackageManifest;
let examBlock: ExamProofBlock;
let fpHash: string;
let nonce: string;
let root: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const entry: ExamAuthorityKey = {
    keyId: 'exam-cli-test-0001',
    algorithm: 'ECDSA-P256',
    publicKeyJwk,
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
  };
  testRegistry.push(entry);

  manifest = await buildExamPackage(
    {
      formatVersion: 1,
      examId: 'exam-1',
      problemId: 'p1',
      variant: null,
      kdf: { algorithm: 'argon2id', salt: 'ab'.repeat(16), params: { memKiB: 256, iterations: 1, parallelism: 1 } },
      releaseTime: '2026-06-06T00:00:00.000Z',
      deadline: '2026-06-06T03:00:00.000Z',
      allowed: { languages: ['c'] },
      keyId: entry.keyId,
      algorithm: 'ECDSA-P256',
    },
    PLAINTEXT,
    TOKEN,
    { keyId: entry.keyId, privateKey: pair.privateKey }
  );

  const packageHash = await computeExamPackageHash(manifest);
  const problemContentHash = await computeProblemContentHash(PLAINTEXT);
  fpHash = await computeHash(deterministicStringify({ lang: 'en-US', tz: 'UTC' }));
  nonce = '7'.repeat(64);
  root = await computeExamChainRoot(fpHash, nonce, packageHash, TOKEN);
  examBlock = buildExamProofBlock({
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    packageHash,
    problemContentHash,
    startToken: TOKEN,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 束縛だけが整った最小の exam proof (チェーン本体の検証結果は見ない)。 */
function examProof(exam: unknown): ProofFile {
  return {
    version: '1.0.0',
    language: 'c',
    content: '',
    metadata: { timestamp: new Date(0).toISOString() },
    fingerprint: { hash: fpHash, components: { lang: 'en-US', tz: 'UTC' } },
    typingProofData: { initialHashNonce: nonce, initialEventChainHash: root, finalEventChainHash: root, metadata: {} },
    proof: { events: [], finalHash: root },
    exam,
  } as unknown as ProofFile;
}

const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});

describe('verifyProof — exam identifiers (#273)', () => {
  it('reports the manifest identifiers as verified when the binding passes', async () => {
    silence();
    const result = await verifyProof(examProof(examBlock), { mode: 'fast', examPackageManifest: manifest });

    expect(result.exam).toMatchObject({
      present: true,
      examId: 'exam-1',
      problemId: 'p1',
      variant: null,
      identifiersVerified: true,
    });
    expect(result.exam?.present && result.exam.binding?.valid).toBe(true);
  });

  it('normalizes an absent proof variant to the manifest null when verified', async () => {
    silence();
    const { variant: _variant, ...withoutVariant } = examBlock;
    const result = await verifyProof(examProof(withoutVariant), { mode: 'fast', examPackageManifest: manifest });

    expect(result.exam).toMatchObject({ identifiersVerified: true, variant: null });
  });

  it('marks the proof-side identifiers as unverified when no package is provided', async () => {
    silence();
    const result = await verifyProof(examProof({ ...examBlock, examId: 'self-claimed' }), { mode: 'fast' });

    expect(result.exam).toMatchObject({
      present: true,
      examId: 'self-claimed',
      identifiersVerified: false,
      packageProvided: false,
    });
  });

  it('fails the whole verification and keeps the identifiers unverified when examId was rewritten', async () => {
    silence();
    const result = await verifyProof(examProof({ ...examBlock, examId: 'other-exam' }), {
      mode: 'fast',
      examPackageManifest: manifest,
    });

    expect(result.valid).toBe(false);
    expect(result.exam).toMatchObject({ present: true, examId: 'other-exam', identifiersVerified: false });
    expect(result.exam?.present && result.exam.binding?.identifiersMatch).toBe(false);
  });
});

describe('formatResult — exam identifiers (#273)', () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの除去そのものが目的
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
  const examLine = (text: string) =>
    plain(text)
      .split('\n')
      .find((l) => l.startsWith('Exam:')) ?? '';

  it('does not label verified identifiers as self-reported', async () => {
    silence();
    const result = await verifyProof(examProof(examBlock), { mode: 'fast', examPackageManifest: manifest });
    expect(examLine(formatResult(result))).not.toContain('self-reported');
  });

  it('labels identifiers as self-reported when no package was provided', async () => {
    silence();
    const result = await verifyProof(examProof(examBlock), { mode: 'fast' });
    expect(examLine(formatResult(result))).toContain('(self-reported)');
  });

  it('labels identifiers as self-reported when the binding failed', async () => {
    silence();
    const result = await verifyProof(examProof({ ...examBlock, examId: 'other-exam' }), {
      mode: 'fast',
      examPackageManifest: manifest,
    });
    const text = formatResult(result);
    expect(examLine(text)).toContain('other-exam');
    expect(examLine(text)).toContain('(self-reported)');
    expect(plain(text)).toMatch(/Identifiers:\s+FAIL/);
  });
});
