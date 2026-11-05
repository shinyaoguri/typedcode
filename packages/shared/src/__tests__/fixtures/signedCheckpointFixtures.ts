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
  /**
   * i 番目の checkpoint の serverTimestamp (ms) を個別に決める。指定すると startServerMs / serverStepMs より優先する
   * (等間隔でない署名時刻を作るため。#320)
   */
  serverMsAt?: (i: number) => number;
  /**
   * i 番目の checkpoint の clientTimestamp (ms) を個別に決める。指定すると startClientMs / clientStepMs より優先する
   * (#320)
   */
  clientMsAt?: (i: number) => number;
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
    serverMsAt = (i: number) => startServerMs + i * serverStepMs,
    clientMsAt = (i: number) => startClientMs + i * clientStepMs,
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
      clientTimestamp: new Date(clientMsAt(i)).toISOString(),
      serverTimestamp: new Date(serverMsAt(i)).toISOString(),
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

/**
 * 署名済み cp 列の payload を書き換え、previousSignedCheckpointHash の連鎖と署名を先頭から付け直す。
 *
 * payload を書き換えるだけだと署名検証や連鎖の検査で先に落ち、狙った 1 つの検査に届かない。
 * 「署名も連鎖も正しく、ある 1 つの検査だけに反する」cp 列を作るために使う。
 * `edit` が previousSignedCheckpointHash を書き換えても、付け直した連鎖で上書きされる。
 * CheckpointData の hash / contentHash / eventIndex は元のまま残す。
 */
export async function resignCheckpoints(
  checkpoints: CheckpointData[],
  key: TestKey,
  edit: (payload: SignedCheckpointPayload, index: number) => SignedCheckpointPayload
): Promise<CheckpointData[]> {
  const out: CheckpointData[] = [];
  let previousSignedCheckpointHash: string | null = null;
  for (let i = 0; i < checkpoints.length; i++) {
    const checkpoint = checkpoints[i]!;
    if (!checkpoint.signature) throw new Error(`Test fixture checkpoint ${i} is not signed`);
    const payload: SignedCheckpointPayload = {
      ...edit({ ...checkpoint.signature.payload }, i),
      previousSignedCheckpointHash,
    };
    out.push({ ...checkpoint, signature: await signCheckpoint(payload, key) });
    previousSignedCheckpointHash = await hashSignedCheckpointPayload(payload);
  }
  return out;
}

/**
 * 合成のイベント列。署名 cp の検証は cp が指す event の hash 一致しか見ない (チェーン全体は
 * verifyChain の責務) ので、密度や時刻の検査は実 PoSW を回さずにこの列で検査できる。
 * hash は index の 16 進を 64 桁に詰めたもの (列の中で一意)。
 *
 * `timestampAt` は i 番目のイベント時刻 (ms)。既定は 10ms 間隔。イベント時刻とサーバ時刻の照合 (#320) を
 * 検査するときに渡す (合成列の hash は時刻に依存しないので、時刻だけを自由に置ける)。
 */
export function makeSyntheticEvents(n: number, timestampAt: (i: number) => number = (i) => i * 10): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      sequence: i,
      timestamp: timestampAt(i),
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

async function computeContentHashAt(event: StoredEvent): Promise<string> {
  // CheckpointManager.createCheckpoint と verifier に合わせ、data が falsy (削除の data: '' を含む) なら空文字 (#571)
  if (!event.data) return '';
  const stringified = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return computeHash(stringified);
}

function nodeRandomSlug(): string {
  return Math.random().toString(36).slice(2, 10);
}
