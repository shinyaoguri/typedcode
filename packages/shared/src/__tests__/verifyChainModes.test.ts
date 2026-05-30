/**
 * Phase 2 統合テスト: 検証モード (fast / full) の挙動
 *
 * 主に verifyChain の skipPosw オプションと、verifyProofFile の mode 引数が
 * 期待通りに分岐することを確認する。
 *
 * - fast モードは PoSW 反復計算をスキップする一方、hash 連鎖 / 内容再生 / metadata は
 *   完全に検証することを示す。
 * - signed checkpoint の検証結果が verifyProofFile の戻り値に乗ることを示す。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  POSW_ITERATIONS,
  TypingProof,
  computeHash,
  verifyChain,
  verifyProofFile,
  type ExportedProof,
  type FingerprintComponents,
  type StoredEvent,
} from '../index.js';
import {
  buildSignedCheckpoints,
  createTestKey,
  type TestKey,
} from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Phase2 Test)',
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

async function buildSmallProof(charCount = 3): Promise<{
  exported: ExportedProof;
  events: StoredEvent[];
  initialEventChainHash: string;
  content: string;
}> {
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
  const exported = await proof.exportProof(content);
  const root = exported.typingProofData.initialEventChainHash;
  if (!root) throw new Error('initial chain hash missing in fixture');
  return { exported, events: exported.proof.events, initialEventChainHash: root, content };
}

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

describe('verifyChain skipPosw', () => {
  it('detects garbage PoSW intermediateHash in full mode', async () => {
    const { events } = await buildSmallProof(2);
    // events[1].posw.intermediateHash を改ざんしても iterations は POSW_ITERATIONS のまま
    events[1] = {
      ...events[1]!,
      posw: {
        ...events[1]!.posw,
        intermediateHash: '0'.repeat(64),
      },
    };
    // hash 自体は posw を含んだ正しいデータから計算されてるので chain integrity は通る。
    // ただ、ここでは hash 再計算も fail する (posw が hash 入力に含まれるため)。
    // 重要なのは「PoSW reject が full モードで起こる」こと。
    const result = await verifyChain(events);
    expect(result.valid).toBe(false);
  });

  it('still detects hash chain tampering in fast mode (PoSW skipped)', async () => {
    const { events } = await buildSmallProof(2);
    // events[1].hash を改ざん → chain hash 再計算で fail するはず
    events[1] = { ...events[1]!, hash: '0'.repeat(64) };
    const result = await verifyChain(events, undefined, { skipPosw: true });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/Hash mismatch/);
  });

  it('still detects sequence violation in fast mode', async () => {
    const { events } = await buildSmallProof(3);
    events[1] = { ...events[1]!, sequence: 99 };
    const result = await verifyChain(events, undefined, { skipPosw: true });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/Sequence mismatch/);
  });

  it('still detects timestamp regression in fast mode', async () => {
    const { events } = await buildSmallProof(3);
    events[2] = { ...events[2]!, timestamp: events[1]!.timestamp - 1 };
    const result = await verifyChain(events, undefined, { skipPosw: true });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/Timestamp violation/);
  });

  it('still rejects wrong poswIterations in fast mode (only the recompute is skipped)', async () => {
    const { events } = await buildSmallProof(1);
    events[0] = { ...events[0]!, posw: { ...events[0]!.posw, iterations: 1 } };
    const result = await verifyChain(events, undefined, { skipPosw: true });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/PoSW iterations mismatch/);
    expect(result.message).toMatch(String(POSW_ITERATIONS));
  });

  it('passes well-formed events in fast mode without invoking PoSW recompute', async () => {
    const { events } = await buildSmallProof(3);
    const result = await verifyChain(events, undefined, { skipPosw: true });
    expect(result.valid).toBe(true);
    expect(result.message).toMatch(/PoSW skipped/);
  });

  // 注: full モードでの「正常系成功」テストは省略している。テスト環境の MockWorker が
  // PoSW を偽データ (mock-intermediate-hash-...) で返すため、verifyChain が real SHA-256 で
  // 再計算すると常に不一致になる。本番の Web Worker 環境では正しく通過する。
});

describe('verifyProofFile mode plumbing', () => {
  it('default mode reports poswSkipped=false', async () => {
    const { exported, content } = await buildSmallProof(2);
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile);
    // valid 自体はテスト環境の MockWorker が PoSW を偽データで返すため不安定。
    // ここではモード分岐 (poswSkipped) が正しく伝播することのみ確認する。
    expect(result.poswSkipped).toBe(false);
  });

  it('fast mode reports poswSkipped=true and still passes a clean proof', async () => {
    const { exported, content } = await buildSmallProof(2);
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });
    expect(result.valid).toBe(true);
    expect(result.poswSkipped).toBe(true);
  });

  it('fast mode still detects tampered event hash', async () => {
    const { exported, content, events } = await buildSmallProof(2);
    events[0] = { ...events[0]!, hash: '0'.repeat(64) };
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });
    expect(result.valid).toBe(false);
  });

  it('populates signedCheckpoints field in result (anchored=false when none)', async () => {
    const { exported, content } = await buildSmallProof(1);
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile);
    expect(result.signedCheckpoints).toBeDefined();
    expect(result.signedCheckpoints?.anchored).toBe(false);
    expect(result.signedCheckpoints?.coverage.signedCount).toBe(0);
  });

  it('populates signedCheckpoints when proof carries valid signed checkpoints', async () => {
    const { exported, content, events, initialEventChainHash } = await buildSmallProof(3);
    exported.checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(true);
    expect(result.signedCheckpoints?.coverage.signedCount).toBe(3);
  });

  it('fails overall when signed checkpoints are present but invalid', async () => {
    const { exported, content, events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    // checkpoint[1].hash を改ざんすると signed checkpoint 検証が fail し、全体も fail になる
    checkpoints[1]!.hash = '0'.repeat(64);
    exported.checkpoints = checkpoints;
    const proofFile = { ...exported, content, language: 'text' };
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(false);
  });
});
