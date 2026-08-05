/**
 * events 配列の構造ゲート (#221)
 *
 * 走査側は防御的に falsy 要素を読み飛ばす一方、`totalEvents` は `events.length` で数えていた。
 * この非対称のせいで、正規 proof の events 末尾にゴミ要素を積んで `metadata.totalEvents` と
 * `typingProofHash` を再計算するだけで、チェーン整合を保ったまま metadata を水増しできた。
 * 再カウント (docs/system-spec.md §7 Layer 1) の手前で構造検証して弾くことを保証する。
 *
 * 注: PoSW は setup.ts の MockWorker が偽データを返すため、verifyProofFile は 'fast' モードで
 * 呼ぶ (verifyChainModes.test.ts と同じ理由)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyEventArrayStructure,
  verifyProofFile,
  verifyProofMetadata,
  type ExportedProof,
  type FingerprintComponents,
  type ProofFile,
  type StoredEvent,
} from '../index.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Event Structure Gate Test)',
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

/** 正規の (改ざんされていない) proof を 1 つ作る。 */
async function buildGenuineProof(charCount = 3): Promise<{ exported: ExportedProof; content: string }> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);

  let content = '';
  for (let i = 0; i < charCount; i++) {
    const ch = String.fromCharCode('a'.charCodeAt(0) + i);
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }

  return { exported: await proof.exportProof(content), content };
}

/**
 * 攻撃者がエクスポート済み JSON を編集する手順を再現する。
 * 1. events 末尾にゴミ要素を積む
 * 2. metadata.totalEvents を配列長に合わせる
 * 3. typingProofHash を再計算する
 * 秘密情報は要らず、sequence / previousHash / finalHash は実イベントのみで整合したままになる。
 */
async function forgeInflatedProof(
  base: { exported: ExportedProof; content: string },
  filler: unknown
): Promise<ProofFile> {
  // 実際の攻撃と同じく JSON を経由する (undefined は落ち、null はそのまま残る)。
  const forged = JSON.parse(JSON.stringify(base.exported)) as ExportedProof;
  (forged.proof.events as unknown[]).push(filler);
  forged.typingProofData.metadata.totalEvents = forged.proof.events.length;
  forged.typingProofHash = await computeHash(JSON.stringify(forged.typingProofData));
  return { ...forged, content: base.content, language: 'text' };
}

let genuine: { exported: ExportedProof; content: string };

beforeAll(async () => {
  genuine = await buildGenuineProof(3);
});

describe('event array structure gate', () => {
  it('accepts an untampered proof', async () => {
    const proofFile: ProofFile = { ...genuine.exported, content: genuine.content, language: 'text' };
    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });

    expect(result.valid).toBe(true);
    expect(result.metadataValid).toBe(true);
  });

  it('rejects a proof padded with null events even after totalEvents and typingProofHash are recomputed', async () => {
    const forged = await forgeInflatedProof(genuine, null);
    const result = await verifyProofFile(forged, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.errorMessage).toMatch(/Invalid event structure at event 3/);
  });

  it('rejects a proof padded with a string event', async () => {
    const forged = await forgeInflatedProof(genuine, 'not-an-event');
    const result = await verifyProofFile(forged, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
  });

  it('rejects a proof padded with a number event', async () => {
    const forged = await forgeInflatedProof(genuine, 42);
    const result = await verifyProofFile(forged, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
  });

  it('rejects a proof padded with an array event', async () => {
    const forged = await forgeInflatedProof(genuine, []);
    const result = await verifyProofFile(forged, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
  });

  it('rejects a null-padded proof before the recomputed totalTypingTime collapses to zero', async () => {
    const forged = await forgeInflatedProof(genuine, null);
    const result = verifyProofMetadata(forged.typingProofData, forged.proof.events);

    expect(result.valid).toBe(false);
    // 再カウント自体を行わないので、0 に落ちた totalTypingTime が申告値の照合に使われない。
    expect(result.recomputedMetadata.totalTypingTime).toBe(0);
    expect(result.recomputedMetadata.totalEvents).toBe(0);
  });
});

describe('verifyEventArrayStructure', () => {
  it('accepts the events of a genuine proof', () => {
    expect(verifyEventArrayStructure(genuine.exported.proof.events)).toEqual({ valid: true });
  });

  it('accepts an empty events array', () => {
    expect(verifyEventArrayStructure([])).toEqual({ valid: true });
  });

  it('reports the index of the first malformed event', () => {
    const events = [...genuine.exported.proof.events] as unknown[];
    events.splice(1, 0, null);

    expect(verifyEventArrayStructure(events)).toMatchObject({ valid: false, errorAt: 1 });
  });

  it('rejects an events value that is not an array', () => {
    expect(verifyEventArrayStructure({ length: 3 })).toMatchObject({
      valid: false,
      reason: 'Proof events is not an array',
    });
  });

  it('rejects an event missing its posw block', () => {
    const [first] = genuine.exported.proof.events;
    const { posw: _posw, ...withoutPosw } = first as StoredEvent;

    expect(verifyEventArrayStructure([withoutPosw])).toMatchObject({
      valid: false,
      reason: 'Invalid event structure at event 0: posw must be an object',
    });
  });

  it('rejects an event whose sequence is not a number', () => {
    const [first] = genuine.exported.proof.events;

    expect(verifyEventArrayStructure([{ ...(first as StoredEvent), sequence: '0' }])).toMatchObject({
      valid: false,
      reason: 'Invalid event structure at event 0: sequence must be a finite number',
    });
  });

  it('accepts an event whose previousHash is null (chain root without a fingerprint anchor)', () => {
    const [first] = genuine.exported.proof.events;

    expect(verifyEventArrayStructure([{ ...(first as StoredEvent), previousHash: null }])).toEqual({ valid: true });
  });
});
