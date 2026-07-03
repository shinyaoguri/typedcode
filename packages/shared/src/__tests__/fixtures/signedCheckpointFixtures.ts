/**
 * Signed checkpoint テスト用 fixture
 *
 * - ECDSA-P256 鍵ペアを生成
 * - 任意の event 列に対して、整合のとれた signed checkpoint チェーンを構築
 *
 * 注: ここで作る鍵はテスト中だけ存在する一時鍵。グローバル registry に登録するのではなく
 * options.registry でテスト関数に注入する。
 */

import {
  POSW_ITERATIONS,
  SIGNED_CHECKPOINT_FORMAT_VERSION,
  computeHash,
  deterministicStringify,
  hashSignedCheckpointPayload,
  type CheckpointData,
  type CheckpointPublicKey,
  type SignedCheckpointEnvelope,
  type SignedCheckpointPayload,
  type StoredEvent,
} from '../../index.js';

export interface TestKey {
  keyId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  registryEntry: CheckpointPublicKey;
}

export async function createTestKey(overrides: Partial<CheckpointPublicKey> = {}): Promise<TestKey> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  const keyId = overrides.keyId ?? `test-key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const registryEntry: CheckpointPublicKey = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk,
    status: overrides.status ?? 'active',
    validFrom: overrides.validFrom ?? '2020-01-01T00:00:00Z',
    validUntil: overrides.validUntil,
    revokedAt: overrides.revokedAt,
    description: overrides.description ?? 'test key',
  };
  return { keyId, publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyJwk, registryEntry };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export async function signCheckpoint(
  payload: SignedCheckpointPayload,
  key: TestKey,
  options: {
    embedPublicKey?: boolean;
    publicKeyValidFrom?: string;
    publicKeyValidUntil?: string;
  } = {}
): Promise<SignedCheckpointEnvelope> {
  const signingInput = new TextEncoder().encode(deterministicStringify(payload));
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    signingInput as unknown as ArrayBuffer
  );
  const signature = bytesToHex(new Uint8Array(signatureBuffer));
  const envelope: SignedCheckpointEnvelope = {
    payload,
    signature,
    keyId: key.keyId,
    algorithm: 'ECDSA-P256',
  };
  if (options.embedPublicKey) {
    envelope.publicKeyJwk = key.publicKeyJwk;
    if (options.publicKeyValidFrom) envelope.publicKeyValidFrom = options.publicKeyValidFrom;
    if (options.publicKeyValidUntil) envelope.publicKeyValidUntil = options.publicKeyValidUntil;
  }
  return envelope;
}

export interface BuildSignedCheckpointsOptions {
  events: StoredEvent[];
  initialEventChainHash: string;
  key: TestKey;
  sessionId?: string;
  tabId?: string;
  firstSeenAt?: string;
  /** どの eventIndex に checkpoint を打つか。指定しなければ全 event に対して打つ */
  eventIndexes?: number[];
  /** 各 checkpoint の clientTimestamp 起点 (ms) */
  startClientMs?: number;
  /** clientTimestamp 同士の間隔 (ms) */
  clientStepMs?: number;
  /** 各 checkpoint の serverTimestamp 起点 (ms) */
  startServerMs?: number;
  /** serverTimestamp 同士の間隔 (ms) */
  serverStepMs?: number;
  /** envelope に公開鍵を同梱するか */
  embedPublicKey?: boolean;
}

/**
 * 指定 event 列に対して整合のとれた signed checkpoint データを構築。
 * 戻り値の CheckpointData をそのまま ExportedProof.checkpoints に入れて使える。
 */
export async function buildSignedCheckpoints(options: BuildSignedCheckpointsOptions): Promise<CheckpointData[]> {
  const {
    events,
    initialEventChainHash,
    key,
    sessionId = 'test-session-' + nodeRandomSlug(),
    tabId = 'test-tab-' + nodeRandomSlug(),
    firstSeenAt = '2026-05-28T12:00:00.000Z',
    eventIndexes = events.map((_, i) => i),
    startClientMs = Date.parse('2026-05-28T12:00:00.000Z'),
    clientStepMs = 1000,
    startServerMs = Date.parse('2026-05-28T12:00:01.000Z'),
    serverStepMs = 1000,
    embedPublicKey = false,
  } = options;

  const out: CheckpointData[] = [];
  let previousSignedCheckpointHash: string | null = null;
  let previousEventIndexCounted = -1;

  for (let i = 0; i < eventIndexes.length; i++) {
    const eventIndex = eventIndexes[i]!;
    const event = events[eventIndex];
    if (!event) throw new Error(`Test fixture eventIndex ${eventIndex} out of bounds`);
    const contentHash = await computeContentHashAt(event);
    const payload: SignedCheckpointPayload = {
      version: SIGNED_CHECKPOINT_FORMAT_VERSION,
      sessionId,
      tabId,
      checkpointIndex: i,
      eventIndex,
      initialEventChainHash,
      chainHash: event.hash,
      contentHash,
      previousSignedCheckpointHash,
      totalEventsSincePrevious: eventIndex - previousEventIndexCounted,
      poswIterations: POSW_ITERATIONS,
      clientTimestamp: new Date(startClientMs + i * clientStepMs).toISOString(),
      serverTimestamp: new Date(startServerMs + i * serverStepMs).toISOString(),
      firstSeenAt,
    };
    const envelope = await signCheckpoint(payload, key, { embedPublicKey });
    out.push({
      eventIndex,
      hash: event.hash,
      timestamp: event.timestamp,
      contentHash,
      signature: envelope,
    });
    previousSignedCheckpointHash = await hashSignedCheckpointPayload(payload);
    previousEventIndexCounted = eventIndex;
  }
  return out;
}

async function computeContentHashAt(event: StoredEvent): Promise<string> {
  if (event.data == null) return '';
  const stringified = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return computeHash(stringified);
}

function nodeRandomSlug(): string {
  return Math.random().toString(36).slice(2, 10);
}
