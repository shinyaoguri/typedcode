/**
 * 試験の許可言語の照合 (#727) の web ↔ CLI パリティ。
 *
 * 同じ試験 proof (正規の package に束縛) を、言語だけ変えて verify (web) の経路と verify-cli の経路に通し、
 * 総合の結論・束縛の合否・許可言語の照合結果が一致することを固定する。`webCliParity.test.ts` は本番の
 * 出題者鍵 registry のまま走るので束縛が通る proof を作れない。ここでは registry をテスト鍵に差し替える。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExamAuthorityKey, ExamPackageManifest, FingerprintComponents } from '@typedcode/shared';

// CLI (verify.ts) は組み込みの EXAM_AUTHORITY_KEYS で package 署名を検証するので、使い捨ての出題者鍵を
// 差し込む (配列を mutate するので factory からは同じ参照を返す)。web は shared の内部の既定 registry を
// 使うのでこの mock が届かず、`examAuthorityRegistry` で同じ配列を渡す。
const { testRegistry } = vi.hoisted(() => ({ testRegistry: [] as unknown[] }));
vi.mock('@typedcode/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typedcode/shared')>();
  return { ...actual, EXAM_AUTHORITY_KEYS: testRegistry };
});

import { TypingProof, computeExamPackageHash, computeHash, computeProblemContentHash } from '@typedcode/shared';
import { buildSamplePackage, makeExamAuthority } from '../../../../shared/src/__tests__/fixtures/examFixtures.js';
import { verifyProof } from '../../../../verify-cli/src/verify.js';
import { isOverallValid, runProofVerification } from '../proofVerification.js';
import type { ProofFile } from '../../types.js';

/** PoSW 用 Worker のスタブ (`webCliParity.test.ts` と同じ。fast モードなので値は固定でよい) */
class PoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage || message.type !== 'compute-posw') return;
      this.onmessage({
        data: {
          type: 'posw-result',
          requestId: message.requestId,
          iterations: message.iterations,
          nonce: 'stub-nonce',
          intermediateHash: 'stub-intermediate-hash',
          computeTimeMs: 1,
        },
      } as MessageEvent);
    });
  }

  terminate(): void {
    // no-op
  }
}

vi.stubGlobal('Worker', PoswWorkerStub);

const components = { userAgent: 'Mozilla/5.0 (Exam Language Parity)', timezone: 'UTC' } as FingerprintComponents;

let manifest: ExamPackageManifest;
let baseProof: ProofFile;

beforeAll(async () => {
  const authority = await makeExamAuthority();
  testRegistry.push(authority.entry as ExamAuthorityKey);
  const pkg = await buildSamplePackage(authority.signer, { languages: ['c', 'python'] });
  manifest = pkg.manifest;

  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initializeExam(fingerprintHash, components, {
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    packageHash: await computeExamPackageHash(manifest),
    problemContentHash: await computeProblemContentHash(pkg.plaintext),
    startToken: pkg.token,
  });
  let content = '';
  for (const ch of 'abc') {
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await proof.exportProof(content);
  baseProof = { ...exported, content, language: 'c' } as ProofFile;
});

interface LanguageConclusion {
  valid: boolean;
  bindingValid: boolean | undefined;
  language: string | undefined;
}

async function webConclusion(proof: ProofFile): Promise<LanguageConclusion> {
  const result = await runProofVerification(proof, {
    mode: 'fast',
    manifest,
    examAuthorityRegistry: testRegistry as ExamAuthorityKey[],
  });
  return {
    valid: isOverallValid(result),
    bindingValid: result.exam?.binding?.valid,
    language: result.exam?.binding?.language?.status,
  };
}

async function cliConclusion(proof: ProofFile): Promise<LanguageConclusion> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const result = await verifyProof(proof as Parameters<typeof verifyProof>[0], {
      mode: 'fast',
      examPackageManifest: manifest,
    });
    const binding = result.exam?.present ? result.exam.binding : undefined;
    return { valid: result.valid, bindingValid: binding?.valid, language: binding?.language?.status };
  } finally {
    log.mockRestore();
  }
}

describe('web ↔ CLI parity — exam allowed languages (#727)', () => {
  it.each(['c', 'python'])('agrees that the allowed language %s passes the binding', async (language) => {
    const proof = { ...baseProof, language };
    const web = await webConclusion(proof);
    const cli = await cliConclusion(proof);

    expect(web).toEqual(cli);
    expect(cli).toEqual({ valid: true, bindingValid: true, language: 'allowed' });
  });

  it('agrees that a disallowed language fails the binding and the overall result', async () => {
    const proof = { ...baseProof, language: 'html' };
    const web = await webConclusion(proof);
    const cli = await cliConclusion(proof);

    expect(web).toEqual(cli);
    expect(cli).toEqual({ valid: false, bindingValid: false, language: 'not-allowed' });
  });
});
