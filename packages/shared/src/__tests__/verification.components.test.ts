/**
 * 検証の部品関数の照合を、関数を直接呼んで確かめるテスト (#500)
 *
 * 変異検査 (#467) で、次の 6 つの拒否の分岐をどのテストも通らないと分かった。
 * - verifyInitialHashRoot: deviceId の照合 / fingerprint components の照合
 * - verifyFinalChainHash: typingProofData.finalEventChainHash の照合
 * - verifyCheckpoints: cp の順序 (昇順・重複なし) / timestamp / contentHash
 *
 * `fingerprint.components` と cp は `typingProofHash` の入力ではないので、proof.json の上で
 * 自由に書き換えられる。ここの照合が唯一の防御になる。
 *
 * 注: PoSW は setup.ts の MockWorker が偽データを返すため、verifyProofFile は 'fast' モードで
 * 呼ぶ (verifyChainModes.test.ts と同じ理由)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyCheckpoints,
  verifyFinalChainHash,
  verifyInitialHashRoot,
  verifyProofFile,
  type ExportedProof,
  type FingerprintComponents,
  type ProofFile,
  type StoredEvent,
} from '../index.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Verification Components Test)',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'TestOS',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1,
  },
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  canvas: 'mock-canvas-fingerprint',
  webgl: { vendor: 'Mock Vendor', renderer: 'Mock Renderer' },
  fonts: ['Arial', 'Helvetica'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

/** 正規の (改ざんされていない) proof を 1 つ作る。 */
async function buildGenuineProof(): Promise<{ exported: ExportedProof; content: string }> {
  const components = createMockFingerprintComponents();
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

  return { exported: await proof.exportProof('a'), content: 'a' };
}

/** JSON を経由して深いコピーを取る (実際の攻撃と同じく、export 済みファイルを書き換える)。 */
const cloneProof = (proof: ExportedProof): ExportedProof => JSON.parse(JSON.stringify(proof)) as ExportedProof;

let genuine: { exported: ExportedProof; content: string };

beforeAll(async () => {
  genuine = await buildGenuineProof();
});

describe('verifyInitialHashRoot component checks', () => {
  it('accepts an untampered proof (positive control)', async () => {
    await expect(verifyInitialHashRoot(genuine.exported)).resolves.toMatchObject({ valid: true });
  });

  it('rejects a deviceId that differs from the fingerprint hash', async () => {
    const forged = cloneProof(genuine.exported);
    forged.typingProofData.deviceId = 'd'.repeat(64);

    await expect(verifyInitialHashRoot(forged)).resolves.toMatchObject({
      valid: false,
      reason: 'Proof deviceId does not match fingerprint hash',
    });
  });

  it('rejects fingerprint components rewritten without updating the fingerprint hash', async () => {
    const forged = cloneProof(genuine.exported);
    forged.fingerprint.components.userAgent = 'Mozilla/5.0 (Another Device)';

    await expect(verifyInitialHashRoot(forged)).resolves.toMatchObject({
      valid: false,
      reason: 'Fingerprint components do not match fingerprint hash',
    });
  });

  it('rejects rewritten fingerprint components through verifyProofFile without recomputing typingProofHash', async () => {
    const forged = cloneProof(genuine.exported);
    forged.fingerprint.components.userAgent = 'Mozilla/5.0 (Another Device)';
    const proofFile: ProofFile = { ...forged, content: genuine.content, language: 'text' };

    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.errorMessage).toBe('Fingerprint components do not match fingerprint hash');
  });
});

describe('verifyFinalChainHash typingProofData check', () => {
  const buildProof = (finalEventChainHash: string): Pick<ExportedProof, 'typingProofData' | 'proof'> =>
    ({
      typingProofData: {
        initialEventChainHash: 'root',
        finalEventChainHash,
        deviceId: 'device',
      },
      proof: { finalHash: 'final', events: [] },
    }) as unknown as Pick<ExportedProof, 'typingProofData' | 'proof'>;

  it('accepts a proof whose proof.finalHash and typingProofData.finalEventChainHash both match (positive control)', () => {
    expect(verifyFinalChainHash(buildProof('final'), 'final')).toMatchObject({ valid: true });
  });

  it('rejects a rewritten typingProofData.finalEventChainHash even when proof.finalHash matches', () => {
    expect(verifyFinalChainHash(buildProof('forged-final'), 'final')).toMatchObject({
      valid: false,
      reason: 'Typing proof final chain hash does not match verified chain hash',
      computedFinalHash: 'final',
      expectedFinalHash: 'forged-final',
    });
  });
});

describe('verifyCheckpoints ordering and content checks', () => {
  const eventAt = (data: string, hash: string, timestamp: number): StoredEvent =>
    ({
      type: 'contentChange',
      inputType: 'insertText',
      data,
      hash,
      timestamp,
    }) as StoredEvent;

  const events: StoredEvent[] = [eventAt('a', 'hash-0', 12), eventAt('b', 'hash-1', 34)];

  let cp0: { eventIndex: number; hash: string; timestamp: number; contentHash: string };
  let cp1: { eventIndex: number; hash: string; timestamp: number; contentHash: string };

  beforeAll(async () => {
    cp0 = { eventIndex: 0, hash: 'hash-0', timestamp: 12, contentHash: await computeHash('a') };
    cp1 = { eventIndex: 1, hash: 'hash-1', timestamp: 34, contentHash: await computeHash('b') };
  });

  it('accepts checkpoints in ascending order that match their events (positive control)', async () => {
    await expect(verifyCheckpoints(events, [cp0, cp1])).resolves.toMatchObject({ valid: true });
  });

  it('rejects checkpoints in descending eventIndex order', async () => {
    await expect(verifyCheckpoints(events, [cp1, cp0])).resolves.toEqual({
      valid: false,
      reason: 'Checkpoint index is invalid or unsorted at event 0',
      errorAt: 0,
    });
  });

  it('rejects two checkpoints that share the same eventIndex', async () => {
    await expect(verifyCheckpoints(events, [cp0, cp0])).resolves.toEqual({
      valid: false,
      reason: 'Checkpoint index is invalid or unsorted at event 0',
      errorAt: 0,
    });
  });

  it('rejects a checkpoint whose timestamp differs from its event', async () => {
    await expect(verifyCheckpoints(events, [{ ...cp0, timestamp: 13 }])).resolves.toEqual({
      valid: false,
      reason: 'Checkpoint timestamp mismatch at event 0',
      errorAt: 0,
    });
  });

  it('rejects a checkpoint whose contentHash differs from its event data', async () => {
    await expect(verifyCheckpoints(events, [{ ...cp0, contentHash: await computeHash('b') }])).resolves.toEqual({
      valid: false,
      reason: 'Checkpoint content hash mismatch at event 0',
      errorAt: 0,
    });
  });
});
