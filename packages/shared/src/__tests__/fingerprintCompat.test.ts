/**
 * fingerprint components の旧形式との互換テスト (#242)
 *
 * 新しい proof は canvas の描画結果とフォント一覧を集めず、WebGL も unmasked の
 * vendor / renderer の 2 値に絞った (ADR-0044)。検証器は proof に同梱された components を
 * そのまま再ハッシュして照合するだけなので、旧形式 (17 キー) の proof も新形式の proof も
 * 受け付け続ける。ここでそれを固定する。あわせて、旧形式の canvas / fonts も hash の入力で
 * あり続ける (消すと照合に落ちる) ことを確かめる。
 *
 * 注: PoSW は setup.ts の MockWorker が偽データを返すため、verifyProofFile は 'fast' モードで
 * 呼ぶ (verification.components.test.ts と同じ理由)。
 */

import { describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyProofFile,
  type CollectedFingerprintComponents,
  type ExportedProof,
  type FingerprintComponents,
  type ProofFile,
} from '../index.js';

const SCREEN = {
  width: 1920,
  height: 1080,
  availWidth: 1920,
  availHeight: 1040,
  colorDepth: 24,
  pixelDepth: 24,
  devicePixelRatio: 1,
};

/** 新形式 (#242 以降の collectComponents が返す 13 キー) */
const newFormatComponents = (): CollectedFingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Fingerprint Compat Test)',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'TestOS',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screen: SCREEN,
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  webgl: { unmaskedVendor: 'Mock GPU Vendor', unmaskedRenderer: 'Mock GPU Renderer' },
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

/** 旧形式 (#242 より前の collectComponents が返した 17 キー相当: canvas・fonts・WebGL 6 値) */
const legacyFormatComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Fingerprint Compat Test)',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'TestOS',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screen: SCREEN,
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  canvas: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAyCAYAAAAZUZThAAAAAXNSR0IArs4c6QAAAAtJREFUeF7tw',
  webgl: {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    unmaskedVendor: 'Mock GPU Vendor',
    unmaskedRenderer: 'Mock GPU Renderer',
  },
  fonts: ['Arial', 'Courier New', 'Helvetica', 'Menlo', 'Monaco'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

/** components から正規の proof を作り、検証器に渡す形 (ProofFile) で返す */
async function buildProofFile(components: FingerprintComponents): Promise<ProofFile> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();

  await proof.initialize(fingerprintHash, components);
  await proof.recordEvent({
    type: 'contentChange',
    inputType: 'insertText',
    data: 'a',
    rangeOffset: 0,
    rangeLength: 0,
  });

  const exported: ExportedProof = await proof.exportProof('a');
  // JSON を経由して export 済みファイルと同じ形にする
  return { ...(JSON.parse(JSON.stringify(exported)) as ExportedProof), content: 'a', language: 'text' };
}

describe('fingerprint components compatibility (#242)', () => {
  it('accepts a proof whose components use the legacy 17-key format with canvas, fonts and six WebGL values', async () => {
    const proofFile = await buildProofFile(legacyFormatComponents());

    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });

    expect(result.valid).toBe(true);
  });

  it('accepts a proof whose components use the new 13-key format without canvas and fonts', async () => {
    const proofFile = await buildProofFile(newFormatComponents());

    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });

    expect(result.valid).toBe(true);
  });

  it('rejects a legacy proof whose canvas was removed without updating the fingerprint hash', async () => {
    const proofFile = await buildProofFile(legacyFormatComponents());
    delete proofFile.fingerprint.components.canvas;

    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Fingerprint components do not match fingerprint hash');
  });
});
