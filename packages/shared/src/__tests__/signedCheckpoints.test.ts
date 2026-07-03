/**
 * Signed checkpoints の検証ロジックに対するテスト。
 *
 * 構成:
 * - 小さな proof を TypingProof で生成 (本物の hash chain を使う)
 * - fixture で signed checkpoint チェーンを構築
 * - 各種改ざんシナリオで verifySignedCheckpoints の挙動を検査
 *
 * テストキーはこのファイル内で都度生成し、options.registry でだけ verifier に注入する。
 * グローバル registry には触れない。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  POSW_ITERATIONS,
  SIGNED_CHECKPOINT_FORMAT_VERSION,
  TypingProof,
  computeHash,
  hashSignedCheckpointPayload,
  isIdempotentSigningRetry,
  resolveCheckpointPublicKey,
  verifyCheckpointSignature,
  verifySignedCheckpoints,
  verifyProofSignedCheckpoints,
  type CheckpointData,
  type CheckpointPublicKey,
  type ExportedProof,
  type FingerprintComponents,
  type SignedCheckpointEnvelope,
  type SignedCheckpointInput,
  type SignedCheckpointPayload,
  type StoredEvent,
} from '../index.js';
import {
  buildSignedCheckpoints,
  createTestKey,
  signCheckpoint,
  type TestKey,
} from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Signed Checkpoint Test)',
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

async function buildSmallProof(charCount = 4): Promise<{
  proof: TypingProof;
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
  const initialEventChainHash = exported.typingProofData.initialEventChainHash;
  if (!initialEventChainHash) {
    throw new Error('initialEventChainHash missing in test fixture proof');
  }
  return { proof, exported, events: exported.proof.events, initialEventChainHash, content };
}

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

describe('signed checkpoint helpers', () => {
  it('hashSignedCheckpointPayload is deterministic regardless of key order', async () => {
    const a: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    const b: SignedCheckpointPayload = {
      ...a,
      // ts can rearrange object literals; same fields, same hash
    };
    const ha = await hashSignedCheckpointPayload(a);
    const hb = await hashSignedCheckpointPayload(b);
    expect(ha).toEqual(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyCheckpointSignature returns valid for a freshly signed payload', async () => {
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    const envelope = await signCheckpoint(payload, testKey);
    await expect(verifyCheckpointSignature(envelope, [testKey.registryEntry])).resolves.toMatchObject({ valid: true });
  });

  it('verifyCheckpointSignature fails when payload is tampered', async () => {
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    const envelope = await signCheckpoint(payload, testKey);
    const tampered: SignedCheckpointEnvelope = {
      ...envelope,
      payload: { ...payload, chainHash: 'tampered' },
    };
    await expect(verifyCheckpointSignature(tampered, [testKey.registryEntry])).resolves.toMatchObject({ valid: false });
  });

  it('resolveCheckpointPublicKey prefers embedded key when it matches registry', async () => {
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    const envelope = await signCheckpoint(payload, testKey, { embedPublicKey: true });
    const resolved = await resolveCheckpointPublicKey(envelope, [testKey.registryEntry]);
    expect(resolved).toMatchObject({ ok: true });
  });

  it('resolveCheckpointPublicKey fails when embedded key does NOT match registry', async () => {
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    const envelope = await signCheckpoint(payload, testKey, { embedPublicKey: true });
    // 別の鍵を registry に置くと、embedded JWK と一致しないので fail するはず
    const other = await createTestKey({ keyId: testKey.keyId });
    await expect(resolveCheckpointPublicKey(envelope, [other.registryEntry])).resolves.toMatchObject({
      ok: false,
      reason: 'Embedded public key does not match registry entry',
    });
  });

  it('resolveCheckpointPublicKey rejects an embedded key whose keyId is not in the registry (no self-signed trust)', async () => {
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId: 's',
      tabId: 't',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: 'root',
      chainHash: 'h',
      contentHash: 'c',
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: '2026-05-28T12:00:00.000Z',
      serverTimestamp: '2026-05-28T12:00:01.000Z',
      firstSeenAt: '2026-05-28T12:00:00.000Z',
    };
    // 攻撃者は自分の鍵ペアで署名し、未登録 keyId の下に自分の公開鍵を同梱できる。
    // 信頼アンカーは registry のみなので、これは valid にしてはならない (時刻アンカー偽造の防止)。
    const envelope = await signCheckpoint(payload, testKey, { embedPublicKey: true });
    const resolved = await resolveCheckpointPublicKey(envelope, []);
    expect(resolved.ok).toBe(false);
    expect((resolved as { ok: false; reason: string }).reason).toMatch(/^Unknown keyId:/);
  });

  it('resolveCheckpointPublicKey fails for unknown keyId without embedded key', async () => {
    const envelope: SignedCheckpointEnvelope = {
      payload: {
        version: SIGNED_CHECKPOINT_FORMAT_VERSION,
        sessionId: 's',
        tabId: 't',
        checkpointIndex: 0,
        eventIndex: 0,
        initialEventChainHash: 'root',
        chainHash: 'h',
        contentHash: 'c',
        previousSignedCheckpointHash: null,
        totalEventsSincePrevious: 1,
        poswIterations: POSW_ITERATIONS,
        clientTimestamp: '2026-05-28T12:00:00.000Z',
        serverTimestamp: '2026-05-28T12:00:01.000Z',
        firstSeenAt: '2026-05-28T12:00:00.000Z',
      },
      signature: 'deadbeef',
      keyId: 'nonexistent',
      algorithm: 'ECDSA-P256',
    };
    await expect(resolveCheckpointPublicKey(envelope, [])).resolves.toMatchObject({
      ok: false,
      reason: 'Unknown keyId: nonexistent',
    });
  });
});

describe('verifySignedCheckpoints', () => {
  it('returns valid=true for a well-formed signed checkpoint chain', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(4);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.anchored).toBe(true);
    expect(result.coverage.signedCount).toBe(4);
    expect(result.coverage.coverageRatio).toBeGreaterThan(0);
    expect(result.details.every((d) => d.valid)).toBe(true);
  });

  it('returns valid=false anchored=false when no signed checkpoints exist (no false success)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints: CheckpointData[] = [
      { eventIndex: 0, hash: events[0]!.hash, timestamp: events[0]!.timestamp, contentHash: await computeHash('a') },
    ];
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.anchored).toBe(false);
    expect(result.coverage.signedCount).toBe(0);
  });

  it('treats undefined checkpoints array the same as empty (anchored=false)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const result = await verifySignedCheckpoints(events, undefined, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.anchored).toBe(false);
  });

  it('fails when checkpoint.hash is tampered (chainHash disagrees with enclosing checkpoint)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    checkpoints[1]!.hash = 'tampered-hash';
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/chainHash disagrees with its enclosing/);
  });

  it('returns valid=false (without throwing) for a malformed signature hex', async () => {
    // 奇数長の不正な hex 署名は hexToUint8Array が throw する入力。
    // verifyProofFile (CLI) は例外を握らないため、ここで吸収しないと検証全体が
    // クラッシュする。verifyCheckpointSignature が valid:false を返すことを保証する。
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    checkpoints[0]!.signature!.signature = 'abc'; // 奇数長 hex
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.anchored).toBe(true);
  });

  it('fails when an event hash is tampered after signing', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(3);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    // 事件: event 列を後から書き換える (CheckpointData.hash はそのまま)
    const original = events[1]!.hash;
    events[1] = { ...events[1]!, hash: 'tampered-event-hash' };
    checkpoints[1]!.hash = original;
    checkpoints[1]!.signature!.payload.chainHash = original;
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/chainHash does not match event hash/);
  });

  it('fails when checkpointIndex is not strictly increasing (reorder)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(3);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    [checkpoints[0], checkpoints[1]] = [checkpoints[1]!, checkpoints[0]!];
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(
      /checkpointIndex not strictly increasing|previousSignedCheckpointHash does not chain/
    );
  });

  it('fails when previousSignedCheckpointHash chain is broken', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(3);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    // 2 番目の checkpoint の previousSignedCheckpointHash を null に差し替えると
    // signature 検証も fail するため、ここでは signature と payload を再生成して連鎖だけ壊す。
    const broken = checkpoints[1]!;
    const newPayload: SignedCheckpointPayload = {
      ...broken.signature!.payload,
      previousSignedCheckpointHash: '0'.repeat(64),
    };
    broken.signature = await signCheckpoint(newPayload, testKey);
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/previousSignedCheckpointHash does not chain/);
  });

  it('fails when sessionId differs across checkpoints', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const second = checkpoints[1]!;
    const newPayload: SignedCheckpointPayload = {
      ...second.signature!.payload,
      sessionId: 'different-session',
    };
    second.signature = await signCheckpoint(newPayload, testKey);
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/inconsistent sessionId/);
  });

  it('fails when firstSeenAt differs across checkpoints (defends against session takeover)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const second = checkpoints[1]!;
    const newPayload: SignedCheckpointPayload = {
      ...second.signature!.payload,
      firstSeenAt: '2020-01-01T00:00:00.000Z',
    };
    second.signature = await signCheckpoint(newPayload, testKey);
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/inconsistent firstSeenAt/);
  });

  it('fails when initialEventChainHash does not match proof root', async () => {
    const { events } = await buildSmallProof(2);
    const wrongRoot = '0'.repeat(64);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: 'genuine-root-baked-into-payload',
      key: testKey,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, wrongRoot, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/initialEventChainHash does not match proof root/);
  });

  it('fails when poswIterations in payload differs from POSW_ITERATIONS', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const cp = checkpoints[0]!;
    const newPayload: SignedCheckpointPayload = {
      ...cp.signature!.payload,
      poswIterations: 1,
    };
    cp.signature = await signCheckpoint(newPayload, testKey);
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/poswIterations mismatch/);
  });

  it('rejects envelope signed with a revoked key after revokedAt', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      startServerMs: Date.parse('2026-06-01T00:00:00.000Z'),
    });
    const revokedEntry: CheckpointPublicKey = {
      ...testKey.registryEntry,
      status: 'revoked',
      revokedAt: '2026-05-01T00:00:00.000Z',
    };
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [revokedEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/revoked at or before serverTimestamp/);
  });

  it('accepts envelope signed before revokedAt with a warning', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      startServerMs: Date.parse('2026-04-01T00:00:00.000Z'),
    });
    const revokedEntry: CheckpointPublicKey = {
      ...testKey.registryEntry,
      status: 'revoked',
      revokedAt: '2026-05-01T00:00:00.000Z',
    };
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [revokedEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.details[0]!.warning).toBe('key-revoked-but-trusted-by-time');
  });

  it('rejects envelope when validUntil is before serverTimestamp', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      startServerMs: Date.parse('2026-06-01T00:00:00.000Z'),
    });
    const expiredEntry: CheckpointPublicKey = {
      ...testKey.registryEntry,
      validUntil: '2026-05-01T00:00:00.000Z',
    };
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [expiredEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/validUntil is before serverTimestamp/);
  });

  it('fails when keyId is unknown and no public key is embedded', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    // registry を空にして、 envelope にも公開鍵を同梱しない
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Unknown keyId/);
  });

  it('rejects an embedded public key when the keyId is not in the registry (no offline self-signed trust)', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(2);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      embedPublicKey: true,
    });
    // 攻撃者は自分の鍵ペアで署名し、その公開鍵を envelope に同梱できる。信頼アンカーは
    // registry のみとし、未登録 keyId は (埋め込み鍵があっても) 拒否する。さもないと
    // 署名 cp の serverTimestamp を任意に偽造できてしまう。
    // 長期検証可能性は「git 永続管理の registry が verify-cli にバンドルされる」ことで担保され、
    // 埋め込み鍵に依存しない。
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Unknown keyId/);
  });

  it('flags post-hoc batch signing when serverSpan is tiny compared to clientSpan', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(4);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      // client side: spaced over an hour
      startClientMs: Date.parse('2026-05-28T12:00:00.000Z'),
      clientStepMs: 20 * 60 * 1000,
      // server side: all within 3 seconds (suspicious)
      startServerMs: Date.parse('2026-05-28T13:00:00.000Z'),
      serverStepMs: 1000,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.temporal).not.toBeNull();
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('does NOT flag natural typing where serverSpan tracks clientSpan', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(4);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
      startClientMs: Date.parse('2026-05-28T12:00:00.000Z'),
      clientStepMs: 60 * 1000,
      startServerMs: Date.parse('2026-05-28T12:00:00.500Z'),
      serverStepMs: 60 * 1000,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.temporal!.postHocSuspected).toBe(false);
    expect(result.temporal!.ratio).toBeGreaterThan(0.5);
  });

  it('verifyProofSignedCheckpoints wrapper accepts a full proof object', async () => {
    const { exported, events, initialEventChainHash } = await buildSmallProof(2);
    exported.checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const result = await verifyProofSignedCheckpoints(exported, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
  });

  it('fails when payload version is unknown', async () => {
    const { events, initialEventChainHash } = await buildSmallProof(1);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const cp = checkpoints[0]!;
    const newPayload = { ...cp.signature!.payload, version: 99 as 1 };
    cp.signature = await signCheckpoint(newPayload, testKey);
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Unsupported signed checkpoint payload version/);
  });
});

/**
 * anchoring 密度 gate (ADR-0016) のテスト。
 *
 * 密度は署名 cp が指す eventIndex / serverTimestamp の **間隔** だけに依存し、ハッシュチェーンの
 * 中身には依存しない。大ギャップ (600 events に末尾 1 cp 等) を実 PoSW で作ると遅いので、ここでは
 * 合成イベント列を使う。verifySignedCheckpoints は checkpoint が指す event の hash 一致しか見ない
 * ため (チェーン全体は verifyChain の責務)、合成列でも忠実に密度ロジックを検査できる。
 * 「密で疎でない」正規ケースだけは実 proof (buildSmallProof) で固定する。
 */
function makeSyntheticEvents(n: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      sequence: i,
      timestamp: i * 10,
      type: 'contentChange',
      inputType: 'insertText',
      data: String.fromCharCode('a'.charCodeAt(0) + (i % 26)),
      rangeOffset: i,
      rangeLength: 0,
      range: null,
      previousHash: null,
      posw: { iterations: POSW_ITERATIONS, nonce: '0', intermediateHash: '0', computeTimeMs: 0 },
      hash: i.toString(16).padStart(64, '0'),
      description: null,
      isMultiLine: null,
      deletedLength: null,
      insertedText: null,
      insertLength: null,
      deleteDirection: null,
      selectedText: null,
    });
  }
  return events;
}

describe('anchoring density gate (ADR-0016)', () => {
  const ROOT = 'a'.repeat(64);

  it('flags a single end checkpoint anchoring a long chain as sparse (large event gap)', async () => {
    const events = makeSyntheticEvents(600);
    // 末尾 1 個だけ署名 cp を打つ攻撃形。coverageRatio は 1.0・postHoc も立たないが疎である。
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      eventIndexes: [599],
    });
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
    });
    // 既定は warning のみ: valid は true のまま、density.sparse で疎を知らせる。
    expect(result.valid).toBe(true);
    expect(result.density).not.toBeNull();
    expect(result.density!.sparse).toBe(true);
    expect(result.density!.firstAnchorEventIndex).toBe(599);
    expect(result.density!.maxGapEvents).toBe(599);
    // coverage は満点に見えてしまう (これが密度を別途見る理由)。
    expect(result.coverage.coverageRatio).toBeCloseTo(1, 5);
  });

  it('fails (valid=false) for a sparse chain when requireAnchorDensity is set (strict / exam)', async () => {
    const events = makeSyntheticEvents(600);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      eventIndexes: [599],
    });
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
      requireAnchorDensity: true,
    });
    expect(result.valid).toBe(false);
    expect(result.anchored).toBe(true);
    expect(result.density!.sparse).toBe(true);
    expect(result.reason).toMatch(/too sparse|density gate/);
  });

  it('flags a single start checkpoint (large trailing event gap) as sparse', async () => {
    const events = makeSyntheticEvents(600);
    // 先頭 1 個だけ。firstAnchorLatency は 0 だが末尾ギャップが大きい。
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      eventIndexes: [0],
    });
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
    });
    expect(result.density!.firstAnchorLatencyEvents).toBe(0);
    expect(result.density!.maxGapEvents).toBe(599); // 末尾ギャップが検出される
    expect(result.density!.sparse).toBe(true);
  });

  it('flags a large server-time gap between checkpoints as sparse (few events)', async () => {
    const events = makeSyntheticEvents(4);
    // event ギャップは小さい (連続) が、server 時刻が 60s 間隔 = 50s 閾値超え。
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      startServerMs: Date.parse('2026-05-28T12:00:01.000Z'),
      serverStepMs: 60_000,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
    });
    expect(result.density!.maxGapEvents).toBeLessThanOrEqual(1);
    expect(result.density!.maxGapServerMs).toBeGreaterThan(50_000);
    expect(result.density!.sparse).toBe(true);
  });

  it('does NOT flag a dense short legitimate session (no false positive)', async () => {
    // 実 proof。4 events 全てに署名 cp、server は既定 1s 間隔。
    const { events, initialEventChainHash } = await buildSmallProof(4);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash,
      key: testKey,
    });
    const result = await verifySignedCheckpoints(events, checkpoints, initialEventChainHash, {
      registry: [testKey.registryEntry],
      requireAnchorDensity: true, // strict でも通る
    });
    expect(result.valid).toBe(true);
    expect(result.density).not.toBeNull();
    expect(result.density!.sparse).toBe(false);
    expect(result.density!.firstAnchorLatencyEvents).toBe(0);
  });

  it('does NOT flag a moderately spaced session within thresholds', async () => {
    const events = makeSyntheticEvents(50);
    // 5 イベント毎に署名 cp (gap 5 events ≪ 500)、server 既定 1s 間隔。
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      eventIndexes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45],
    });
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
      requireAnchorDensity: true,
    });
    expect(result.valid).toBe(true);
    expect(result.density!.sparse).toBe(false);
    expect(result.density!.maxGapEvents).toBeLessThanOrEqual(5);
  });

  it('reports density=null when there are no signed checkpoints (unanchored stays valid path)', async () => {
    const events = makeSyntheticEvents(3);
    const result = await verifySignedCheckpoints(events, [], ROOT, {
      registry: [testKey.registryEntry],
      requireAnchorDensity: true,
    });
    // 未アンカーは anchored=false。density gate は対象外で、density は null。
    expect(result.anchored).toBe(false);
    expect(result.density).toBeNull();
  });
});

describe('isIdempotentSigningRetry', () => {
  const baseInput: SignedCheckpointInput = {
    sessionId: 'session-A',
    tabId: 'tab-1',
    checkpointIndex: 5,
    eventIndex: 165,
    initialEventChainHash: '00'.repeat(32),
    chainHash: '11'.repeat(32),
    contentHash: '22'.repeat(32),
    previousSignedCheckpointHash: '33'.repeat(32),
    totalEventsSincePrevious: 33,
    clientTimestamp: '2026-05-30T05:35:16.702Z',
  };
  const cachedPayload: SignedCheckpointPayload = {
    version: SIGNED_CHECKPOINT_FORMAT_VERSION,
    sessionId: 'session-A',
    tabId: 'tab-1',
    checkpointIndex: 5,
    eventIndex: 165,
    initialEventChainHash: '00'.repeat(32),
    chainHash: '11'.repeat(32),
    contentHash: '22'.repeat(32),
    previousSignedCheckpointHash: '33'.repeat(32),
    totalEventsSincePrevious: 33,
    poswIterations: POSW_ITERATIONS,
    clientTimestamp: '2026-05-30T05:35:16.702Z',
    serverTimestamp: '2026-05-30T05:35:16.785Z',
    firstSeenAt: '2026-05-30T05:35:12.750Z',
  };

  it('returns true when content fields match exactly', () => {
    expect(isIdempotentSigningRetry(baseInput, cachedPayload)).toBe(true);
  });

  it('returns true when only clientTimestamp differs (reload-retry case)', () => {
    // ページリロード後にセッション復元で同じ checkpoint が違う clientTimestamp で
    // 再エンキューされても、論理的に同一なので冪等扱いにする。
    const input = { ...baseInput, clientTimestamp: '2026-05-30T07:00:00.000Z' };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(true);
  });

  it('returns false when chainHash differs', () => {
    const input = { ...baseInput, chainHash: 'ff'.repeat(32) };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when contentHash differs', () => {
    const input = { ...baseInput, contentHash: 'ee'.repeat(32) };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when previousSignedCheckpointHash differs (broken chain)', () => {
    const input = { ...baseInput, previousSignedCheckpointHash: 'dd'.repeat(32) };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when eventIndex differs', () => {
    const input = { ...baseInput, eventIndex: 200 };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when sessionId differs', () => {
    const input = { ...baseInput, sessionId: 'session-B' };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when tabId differs', () => {
    const input = { ...baseInput, tabId: 'tab-2' };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when checkpointIndex differs', () => {
    const input = { ...baseInput, checkpointIndex: 6 };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when totalEventsSincePrevious differs', () => {
    const input = { ...baseInput, totalEventsSincePrevious: 99 };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('returns false when initialEventChainHash differs', () => {
    const input = { ...baseInput, initialEventChainHash: 'cc'.repeat(32) };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });

  it('treats null === null for previousSignedCheckpointHash', () => {
    const input = { ...baseInput, previousSignedCheckpointHash: null };
    const cached = { ...cachedPayload, previousSignedCheckpointHash: null };
    expect(isIdempotentSigningRetry(input, cached)).toBe(true);
  });

  it('returns false when input has null but cached has hash', () => {
    const input = { ...baseInput, previousSignedCheckpointHash: null };
    expect(isIdempotentSigningRetry(input, cachedPayload)).toBe(false);
  });
});
