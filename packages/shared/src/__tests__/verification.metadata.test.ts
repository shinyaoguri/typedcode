/**
 * 申告メタデータの照合と metadataValid の合成が実際に拒否することを固定するテスト (#498, #467 系統 3・4)
 *
 * - 系統 3: `verifyProofFile` が `metadataValid` を `metaResult.valid && rootValid && eventMetadataResult.valid`
 *   で合成する箇所。`typingProofHash` の不一致と root の不一致が、それぞれ単独で metadata を落とすこと。
 * - 系統 4: `verifyProofMetadata` が申告値 (pasteEvents など) と再計算値を照合する箇所と、
 *   `recomputeProofMetadata` の再カウント条件。申告を偽って `typingProofHash` を再計算しても通らないこと、
 *   および貼り付け・ドロップ・削除を含む正規 proof が通ること (正の対照)。
 *
 * 注: PoSW は setup.ts の MockWorker が偽データを返すため、verifyProofFile は 'fast' モードで
 * 呼ぶ (verifyChainModes.test.ts と同じ理由)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  POSW_ITERATIONS,
  TypingProof,
  computeHash,
  verifyProofFile,
  verifyProofMetadata,
  type ExportedProof,
  type FingerprintComponents,
  type ProofData,
  type ProofFile,
  type StoredEvent,
} from '../index.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Metadata Verification Test)',
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

type Op =
  | { kind: 'type'; text: string }
  | { kind: 'delete'; offset: number; length: number }
  | { kind: 'paste'; text: string }
  | { kind: 'drop'; text: string };

/** 操作列を `TypingProof` に流して、正規の (改ざんされていない) proof と最終内容を作る。 */
async function buildProof(ops: Op[]): Promise<{ exported: ExportedProof; content: string }> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);

  let content = '';
  for (const op of ops) {
    if (op.kind === 'type') {
      for (const ch of op.text) {
        await proof.recordEvent({
          type: 'contentChange',
          inputType: 'insertText',
          data: ch,
          rangeOffset: content.length,
          rangeLength: 0,
        });
        content += ch;
      }
    } else if (op.kind === 'delete') {
      await proof.recordEvent({
        type: 'contentChange',
        inputType: 'deleteContentBackward',
        data: '',
        rangeOffset: op.offset,
        rangeLength: op.length,
      });
      content = content.slice(0, op.offset) + content.slice(op.offset + op.length);
    } else {
      await proof.recordEvent({
        type: 'contentChange',
        inputType: op.kind === 'paste' ? 'insertFromPaste' : 'insertFromDrop',
        data: op.text,
        rangeOffset: content.length,
        rangeLength: 0,
      });
      content += op.text;
    }
  }

  return { exported: await proof.exportProof(content), content };
}

/** JSON を経由して複製する (実際の攻撃と同じく、エクスポート済み JSON を編集する形)。 */
const cloneProof = (base: { exported: ExportedProof; content: string }): ProofFile => ({
  ...(JSON.parse(JSON.stringify(base.exported)) as ExportedProof),
  content: base.content,
  language: 'text',
});

/** `typingProofData` を編集したあと `typingProofHash` を再計算する (攻撃者が秘密情報なしでできる手順)。 */
async function rehash(proofFile: ProofFile): Promise<ProofFile> {
  proofFile.typingProofHash = await computeHash(JSON.stringify(proofFile.typingProofData));
  return proofFile;
}

const verifyFast = (proofFile: ProofFile) => verifyProofFile(proofFile, undefined, { mode: 'fast' });

let plain: { exported: ExportedProof; content: string };
let withPaste: { exported: ExportedProof; content: string };
let mixed: { exported: ExportedProof; content: string };

beforeAll(async () => {
  plain = await buildProof([{ kind: 'type', text: 'abc' }]);
  withPaste = await buildProof([
    { kind: 'type', text: 'ab' },
    { kind: 'paste', text: 'x' },
  ]);
  // a b を打ち、b を消し、x を貼り、y をドロップして最終内容 axy。
  mixed = await buildProof([
    { kind: 'type', text: 'ab' },
    { kind: 'delete', offset: 1, length: 1 },
    { kind: 'paste', text: 'x' },
    { kind: 'drop', text: 'y' },
  ]);
});

describe('verifyProofFile: metadataValid の合成 (typingProofHash && root && 申告照合)', () => {
  it('accepts an untampered proof (positive control)', async () => {
    const result = await verifyFast(cloneProof(plain));

    expect(result.valid).toBe(true);
    expect(result.metadataValid).toBe(true);
    expect(result.rootValid).toBe(true);
  });

  it('rejects a proof whose typingProofHash alone is wrong, even though the root is still valid', async () => {
    const forged = cloneProof(plain);
    forged.typingProofHash = '0'.repeat(64);

    const result = await verifyFast(forged);

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.rootValid).toBe(true);
    expect(result.errorMessage).toMatch(/^Typing proof hash does not match metadata/);
  });

  it('rejects a proof whose root is wrong even though typingProofHash was recomputed to match', async () => {
    const forged = cloneProof(plain);
    forged.typingProofData.initialHashNonce = '0'.repeat(64);
    await rehash(forged);

    const result = await verifyFast(forged);

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.rootValid).toBe(false);
    expect(result.errorMessage).toBe('Initial event chain hash does not match fingerprint and nonce');
  });
});

describe('verifyProofFile: 申告メタデータの偽装は typingProofHash を再計算しても通らない', () => {
  it('rejects a proof that hides a paste by claiming pasteEvents: 0 and recomputing typingProofHash', async () => {
    // 偽装前の proof は通る (対照)。
    expect((await verifyFast(cloneProof(withPaste))).valid).toBe(true);

    const forged = cloneProof(withPaste);
    expect(forged.typingProofData.metadata.pasteEvents).toBe(1);
    forged.typingProofData.metadata.pasteEvents = 0;
    await rehash(forged);

    const result = await verifyFast(forged);

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.errorMessage).toBe('Proof metadata mismatch for pasteEvents: expected 1, got 0');
  });

  it('accepts a genuine proof containing insertText, delete, paste and drop events (positive control for the recount)', async () => {
    const proofFile = cloneProof(mixed);
    expect(proofFile.content).toBe('axy');
    expect(proofFile.typingProofData.metadata).toMatchObject({
      pasteEvents: 1,
      dropEvents: 1,
      deleteEvents: 1,
      insertEvents: 4,
    });

    const result = await verifyFast(proofFile);

    expect(result.valid).toBe(true);
    expect(result.metadataValid).toBe(true);
  });
});

/** `verifyProofMetadata` 用の最小イベント列 (verification.test.ts の metadataEvents と同じ形)。 */
const minimalEvents = (partials: Array<Partial<StoredEvent>>): StoredEvent[] =>
  partials.map(
    (partial, index) =>
      ({
        sequence: index,
        timestamp: 0,
        type: 'contentChange',
        inputType: null,
        data: null,
        rangeOffset: null,
        rangeLength: null,
        range: null,
        previousHash: null,
        posw: {
          iterations: POSW_ITERATIONS,
          nonce: '0'.repeat(16),
          intermediateHash: '0'.repeat(64),
          computeTimeMs: 1,
        },
        ...partial,
      }) as StoredEvent
  );

const proofDataFrom = (metadata: ProofData['metadata']): ProofData => ({ metadata }) as ProofData;

/** 申告を空にして一度呼び、再計算値だけを取り出す。 */
const recomputedFor = (events: StoredEvent[]): ProofData['metadata'] =>
  verifyProofMetadata(proofDataFrom({} as ProofData['metadata']), events).recomputedMetadata as ProofData['metadata'];

describe('verifyProofMetadata: 申告値と再計算値の照合', () => {
  // countKeys の 6 キーがすべて 1 以上になるイベント列。
  const events = minimalEvents([
    { type: 'contentChange', inputType: 'insertText', data: 'a', timestamp: 10 },
    { type: 'contentChange', inputType: 'insertFromPaste', data: 'b', timestamp: 20 },
    { type: 'contentChange', inputType: 'insertFromInternalPaste', data: 'c', timestamp: 30 },
    { type: 'contentChange', inputType: 'insertFromDrop', data: 'd', timestamp: 40 },
    { type: 'contentChange', inputType: 'deleteContentBackward', data: '', timestamp: 50 },
  ]);
  const recomputed = recomputedFor(events);

  it('accepts the claimed metadata when it equals the recomputed values (positive control)', () => {
    const result = verifyProofMetadata(proofDataFrom({ ...recomputed }), events);

    expect(result.valid).toBe(true);
    expect(result.recomputedMetadata).toMatchObject({
      totalEvents: 5,
      pasteEvents: 1,
      internalPasteEvents: 1,
      dropEvents: 1,
      insertEvents: 4,
      deleteEvents: 1,
    });
  });

  it.each(['totalEvents', 'pasteEvents', 'internalPasteEvents', 'dropEvents', 'insertEvents', 'deleteEvents'] as const)(
    'rejects a claimed %s that is one more than the recomputed value',
    (key) => {
      const expected = recomputed[key];
      const claimed = { ...recomputed, [key]: expected + 1 };

      const result = verifyProofMetadata(proofDataFrom(claimed), events);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe(`Proof metadata mismatch for ${key}: expected ${expected}, got ${expected + 1}`);
    }
  );

  it('rejects a claimed totalTypingTime shorter than the last event timestamp, and accepts an equal one', () => {
    const timeline = minimalEvents([{ type: 'contentChange', inputType: 'insertText', data: 'a', timestamp: 5000 }]);
    const base = recomputedFor(timeline);

    const short = verifyProofMetadata(proofDataFrom({ ...base, totalTypingTime: 4999 }), timeline);
    expect(short.valid).toBe(false);
    expect(short.reason).toBe('Proof metadata totalTypingTime is shorter than the event timeline');

    // ちょうど一致は許す (境界)。
    const exact = verifyProofMetadata(proofDataFrom({ ...base, totalTypingTime: 5000 }), timeline);
    expect(exact.valid).toBe(true);
  });
});
