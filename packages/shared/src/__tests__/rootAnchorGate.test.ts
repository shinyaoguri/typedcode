/**
 * root アンカー必須 gate (ADR-0017 / #131) のテスト。
 *
 * #131: gate の exam 免除が `proof.exam` の**存在だけ**で成立していた。exam root は proof 内の
 * 宣言値から自己完結で再計算されるため、完全オフラインで捏造した proof に架空の exam ブロックを
 * 付けるだけで `--require-root-anchor` を回避できた。免除は「束縛が実際に検証済み
 * (`examBindingVerified`)」のときのみに限定する。
 */

import { describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyProofFile,
  type ExamSessionContext,
  type FingerprintComponents,
} from '../index.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (RootAnchorGate Test)',
  language: 'en',
  languages: ['en'],
  platform: 'TestOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 860,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

/** 攻撃シナリオそのもの: 架空の束縛値で exam root を自己整合させた捏造 proof。 */
const forgedExamContext = (): ExamSessionContext => ({
  examId: 'forged-exam',
  problemId: 'p1',
  variant: null,
  packageHash: 'f'.repeat(64),
  problemContentHash: 'e'.repeat(64),
  startToken: 'FORGED-TOKEN',
});

async function buildProof(examContext?: ExamSessionContext) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  if (examContext) {
    await proof.initializeExam(fingerprintHash, components, examContext);
  } else {
    await proof.initialize(fingerprintHash, components);
  }
  let content = '';
  for (const ch of ['a', 'b', 'c']) {
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
  return { ...exported, content, language: 'text' };
}

describe('verifyProofFile requireRootAnchor gate (ADR-0017 / #131)', () => {
  it('accepts an unanchored casual proof when the gate is off (default)', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });
    expect(result.valid).toBe(true);
    expect(result.rootAnchored).toBe(false);
  });

  it('fails an unanchored casual proof when root anchoring is required', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      requireRootAnchor: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toMatch(/root anchoring is required/i);
  });

  it('fails a self-declared exam proof whose binding is not verified (#131)', async () => {
    // 架空の exam ブロック付き捏造 proof。root は exam 式で自己整合するが、束縛は未検証。
    const proofFile = await buildProof(forgedExamContext());
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      requireRootAnchor: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toMatch(/exam binding is not verified/i);
  });

  it('exempts an exam proof when the caller attests the binding is verified', async () => {
    const proofFile = await buildProof(forgedExamContext());
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      requireRootAnchor: true,
      examBindingVerified: true,
    });
    expect(result.valid).toBe(true);
  });

  it('does not exempt a non-exam proof even when examBindingVerified is passed', async () => {
    // 呼び出し側の配線ミス (無条件 true 渡し) が casual proof の gate を殺さないこと。
    const proofFile = await buildProof();
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      requireRootAnchor: true,
      examBindingVerified: true,
    });
    expect(result.valid).toBe(false);
  });
});
