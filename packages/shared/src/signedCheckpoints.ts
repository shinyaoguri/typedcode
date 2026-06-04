/**
 * Signed Checkpoints の検証ロジック
 *
 * 役割の整理:
 * - hashSignedCheckpointPayload: payload の決定的ハッシュ (previousSignedCheckpointHash 連鎖の計算用)
 * - verifyCheckpointSignature: ECDSA-P256 署名の検証
 * - resolveCheckpointPublicKey: envelope の keyId と同梱鍵から CryptoKey を解決
 * - verifySignedCheckpoints: チェーン全体の検証 (連鎖整合性 + 個別署名 + post-hoc 疑い指標)
 *
 * 注: ここでは PoSW や hash chain の再計算は行わない。それらは verifyChain 等が担当する。
 *     ここは「envelope 自体の整合性」と「event との指し示し関係」のみを扱う。
 */

import type {
  SignedCheckpointEnvelope,
  SignedCheckpointPayload,
  SignedCheckpointVerificationDetail,
  SignedCheckpointsVerificationResult,
} from './types/signedCheckpoint.js';
// CheckpointData / StoredEvent / ExportedProof は proof データ全体を扱う型なので
// types/proof.ts (browser 依存) から取ってくる。Workers から import される
// checkpointEntry.ts は verifyProofSignedCheckpoints を再エクスポートするが、
// 関数本体は CheckpointData の構造しか触らないので browser 実装は要らない。
import type {
  CheckpointData,
  ExportedProof,
  StoredEvent,
} from './types/proof.js';
import { POSW_ITERATIONS, SIGNED_CHECKPOINT_FORMAT_VERSION } from './version.js';
import { computeHash, deterministicStringify } from './utils/hashUtils.js';
import {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
  type CheckpointPublicKey,
} from './checkpointKeys/index.js';

const POST_HOC_RATIO_THRESHOLD = 0.1;
const POST_HOC_MIN_SERVER_SPAN_MS = 60 * 1000;
const POST_HOC_MIN_CLIENT_SPAN_MS = 10 * 60 * 1000;

/**
 * Signed checkpoint 作成時に編集側 (またはサーバ側エンドポイント) が提供する入力。
 * `serverTimestamp` / `firstSeenAt` / `poswIterations` / `version` は
 * サーバ/ライブラリ側で確定するためここには含めない。
 */
export interface SignedCheckpointInput {
  sessionId: string;
  tabId: string;
  checkpointIndex: number;
  eventIndex: number;
  initialEventChainHash: string;
  chainHash: string;
  contentHash: string;
  previousSignedCheckpointHash: string | null;
  totalEventsSincePrevious: number;
  clientTimestamp: string;
}

export interface SignedCheckpointServerContext {
  serverTimestamp: string;
  firstSeenAt: string;
}

export interface SignedCheckpointSigner {
  keyId: string;
  privateKey: CryptoKey;
  /** 任意で同梱する公開鍵 (long-term verifiability) */
  publicKeyJwk?: JsonWebKey;
  publicKeyValidFrom?: string;
  publicKeyValidUntil?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Signed checkpoint envelope を作成 (canonical form で署名).
 *
 * 検証ロジックとシリアライズ規約を共有するために shared に置く。
 * Workers の signing endpoint、editor 側のローカル test fixture、verify-cli の
 * 全てから同一関数を呼ぶことで「同じ envelope 形式」を保証する。
 */
export async function createSignedCheckpointEnvelope(
  input: SignedCheckpointInput,
  serverContext: SignedCheckpointServerContext,
  signer: SignedCheckpointSigner
): Promise<SignedCheckpointEnvelope> {
  const payload: SignedCheckpointPayload = {
    version: SIGNED_CHECKPOINT_FORMAT_VERSION,
    sessionId: input.sessionId,
    tabId: input.tabId,
    checkpointIndex: input.checkpointIndex,
    eventIndex: input.eventIndex,
    initialEventChainHash: input.initialEventChainHash,
    chainHash: input.chainHash,
    contentHash: input.contentHash,
    previousSignedCheckpointHash: input.previousSignedCheckpointHash,
    totalEventsSincePrevious: input.totalEventsSincePrevious,
    poswIterations: POSW_ITERATIONS,
    clientTimestamp: input.clientTimestamp,
    serverTimestamp: serverContext.serverTimestamp,
    firstSeenAt: serverContext.firstSeenAt,
  };

  const signingInput = new TextEncoder().encode(deterministicStringify(payload));
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.privateKey,
    signingInput as unknown as ArrayBuffer
  );

  const envelope: SignedCheckpointEnvelope = {
    payload,
    signature: bytesToHex(new Uint8Array(sigBuffer)),
    keyId: signer.keyId,
    algorithm: 'ECDSA-P256',
  };
  if (signer.publicKeyJwk) envelope.publicKeyJwk = signer.publicKeyJwk;
  if (signer.publicKeyValidFrom) envelope.publicKeyValidFrom = signer.publicKeyValidFrom;
  if (signer.publicKeyValidUntil) envelope.publicKeyValidUntil = signer.publicKeyValidUntil;
  return envelope;
}

/**
 * untrusted な SignedCheckpointInput を検証する。
 * Workers の入力バリデーションでも使用。
 */
export function validateSignedCheckpointInput(
  raw: unknown
): { ok: true; input: SignedCheckpointInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'Input must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const strFields = [
    'sessionId',
    'tabId',
    'initialEventChainHash',
    'chainHash',
    'contentHash',
    'clientTimestamp',
  ] as const;
  for (const k of strFields) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).length === 0) {
      return { ok: false, reason: `Missing or invalid ${k}` };
    }
  }
  const intFields = ['checkpointIndex', 'eventIndex', 'totalEventsSincePrevious'] as const;
  for (const k of intFields) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return { ok: false, reason: `Missing or invalid ${k}` };
    }
  }
  if (
    obj.previousSignedCheckpointHash !== null &&
    (typeof obj.previousSignedCheckpointHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(obj.previousSignedCheckpointHash as string))
  ) {
    return { ok: false, reason: 'previousSignedCheckpointHash must be null or 64-hex string' };
  }
  if (Number.isNaN(Date.parse(obj.clientTimestamp as string))) {
    return { ok: false, reason: 'clientTimestamp must be a valid ISO date' };
  }
  return {
    ok: true,
    input: {
      sessionId: obj.sessionId as string,
      tabId: obj.tabId as string,
      checkpointIndex: obj.checkpointIndex as number,
      eventIndex: obj.eventIndex as number,
      initialEventChainHash: obj.initialEventChainHash as string,
      chainHash: obj.chainHash as string,
      contentHash: obj.contentHash as string,
      previousSignedCheckpointHash: obj.previousSignedCheckpointHash as string | null,
      totalEventsSincePrevious: obj.totalEventsSincePrevious as number,
      clientTimestamp: obj.clientTimestamp as string,
    },
  };
}

/**
 * Signed checkpoint payload の決定的ハッシュ。
 * `previousSignedCheckpointHash` 連鎖の計算と、配列内一意性の特定に用いる。
 */
export async function hashSignedCheckpointPayload(
  payload: SignedCheckpointPayload
): Promise<string> {
  return computeHash(deterministicStringify(payload));
}

/**
 * 同一 `(sessionId, checkpointIndex)` に対する再要求が「論理的に同じ checkpoint」
 * を指しているかを判定する。worker は判定が `true` のとき、新たに署名を発行
 * せずキャッシュ済 envelope を返すことで冪等性を担保し、応答喪失からのリトライ
 * を救済する。
 *
 * 連鎖整合に関与するフィールド (sessionId, tabId, checkpointIndex, eventIndex,
 * initialEventChainHash, chainHash, contentHash, previousSignedCheckpointHash,
 * totalEventsSincePrevious) を比較する。`clientTimestamp` は意図的に除外
 * している: ページリロード後のセッション復元で同じ checkpoint が異なる
 * clientTimestamp で再エンキューされ得るが、連鎖検証性には影響しないため、
 * 内容として同一なら救済する方が運用上望ましい。
 */
export function isIdempotentSigningRetry(
  input: SignedCheckpointInput,
  cached: SignedCheckpointPayload
): boolean {
  return (
    input.sessionId === cached.sessionId &&
    input.tabId === cached.tabId &&
    input.checkpointIndex === cached.checkpointIndex &&
    input.eventIndex === cached.eventIndex &&
    input.initialEventChainHash === cached.initialEventChainHash &&
    input.chainHash === cached.chainHash &&
    input.contentHash === cached.contentHash &&
    input.previousSignedCheckpointHash === cached.previousSignedCheckpointHash &&
    input.totalEventsSincePrevious === cached.totalEventsSincePrevious
  );
}

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * envelope の keyId と同梱公開鍵から検証用 CryptoKey を解決する。
 * 解決優先順:
 *   1. envelope に publicKeyJwk が同梱されていればそれ (ただし keyId が registry にある場合は JWK 一致が必須)
 *   2. registry から keyId で引いた公開鍵
 *   3. いずれも無ければ null
 */
export async function resolveCheckpointPublicKey(
  envelope: SignedCheckpointEnvelope,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): Promise<
  | { ok: true; cryptoKey: CryptoKey; registryEntry: CheckpointPublicKey | null }
  | { ok: false; reason: string }
> {
  const registryEntry = findCheckpointPublicKey(envelope.keyId, registry) ?? null;
  let jwk: JsonWebKey | undefined;

  if (envelope.publicKeyJwk) {
    if (registryEntry) {
      const sameJwk =
        deterministicStringify(envelope.publicKeyJwk) ===
        deterministicStringify(registryEntry.publicKeyJwk);
      if (!sameJwk) {
        return { ok: false, reason: 'Embedded public key does not match registry entry' };
      }
    }
    jwk = envelope.publicKeyJwk;
  } else if (registryEntry) {
    jwk = registryEntry.publicKeyJwk;
  }

  if (!jwk) {
    return { ok: false, reason: `Unknown keyId: ${envelope.keyId}` };
  }

  if (envelope.algorithm !== 'ECDSA-P256') {
    return { ok: false, reason: `Unsupported algorithm: ${envelope.algorithm}` };
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  return { ok: true, cryptoKey, registryEntry };
}

/**
 * ECDSA-P256 で envelope の payload に対する署名を検証する。
 * 公開鍵解決まで含む。
 */
export async function verifyCheckpointSignature(
  envelope: SignedCheckpointEnvelope,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): Promise<{ valid: boolean; reason?: string; registryEntry?: CheckpointPublicKey | null }> {
  const resolved = await resolveCheckpointPublicKey(envelope, registry);
  if (!resolved.ok) {
    return { valid: false, reason: resolved.reason };
  }

  const signingInput = new TextEncoder().encode(deterministicStringify(envelope.payload));
  const signatureBytes = hexToUint8Array(envelope.signature);

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    resolved.cryptoKey,
    signatureBytes as unknown as ArrayBuffer,
    signingInput as unknown as ArrayBuffer
  );

  return { valid, registryEntry: resolved.registryEntry };
}

interface VerifySignedCheckpointsOptions {
  registry?: readonly CheckpointPublicKey[];
}

/**
 * Signed checkpoint 配列全体の検証。
 *
 * 入力:
 * - events: 既に hash chain として整合性が verifyChain 等で検証されているイベント列
 * - checkpoints: ExportedProof.checkpoints (一部だけ signature を持っていても良い)
 * - initialEventChainHash: proof の root (各 envelope の initialEventChainHash と照合)
 *
 * 戻り値:
 * - valid: 一つでも signature が存在し、全 signed checkpoint が合格すれば true
 * - anchored: 少なくとも一つの signed checkpoint が存在すれば true
 * - details / coverage / temporal: UI 表示用の補助情報
 */
export async function verifySignedCheckpoints(
  events: StoredEvent[],
  checkpoints: CheckpointData[] | undefined,
  initialEventChainHash: string | null | undefined,
  options: VerifySignedCheckpointsOptions = {}
): Promise<SignedCheckpointsVerificationResult> {
  const registry = options.registry ?? CHECKPOINT_PUBLIC_KEYS;
  const signedCheckpoints = (checkpoints ?? []).filter(
    (cp): cp is CheckpointData & { signature: SignedCheckpointEnvelope } => !!cp.signature
  );

  const baseResult: SignedCheckpointsVerificationResult = {
    valid: false,
    anchored: false,
    details: [],
    coverage: { signedCount: 0, lastSignedEventIndex: null, coverageRatio: 0 },
    temporal: null,
  };

  if (signedCheckpoints.length === 0) {
    // signed checkpoint が存在しないこと自体は failure ではない。
    // ただし anchored=false なので、呼び出し側が「anchoring unavailable」を表示する責務を持つ。
    return { ...baseResult, valid: false };
  }

  const details: SignedCheckpointVerificationDetail[] = [];

  let previousPayloadHash: string | null = null;
  let previousCheckpointIndex = -Infinity;
  let previousEventIndex = -Infinity;
  let previousServerTimestamp = -Infinity;
  let sessionId: string | null = null;
  let firstSeenAt: string | null = null;
  let firstClientTs: number | null = null;
  let lastClientTs: number | null = null;
  let firstServerTs: number | null = null;
  let lastServerTs: number | null = null;

  const fail = (
    detail: SignedCheckpointVerificationDetail,
    reason: string,
    errorAt?: number
  ): SignedCheckpointsVerificationResult => {
    details.push(detail);
    return {
      ...baseResult,
      anchored: true,
      details,
      coverage: computeCoverage(events, signedCheckpoints),
      temporal: computeTemporal(firstClientTs, lastClientTs, firstServerTs, lastServerTs),
      valid: false,
      reason,
      errorAt,
    };
  };

  for (const checkpoint of signedCheckpoints) {
    const envelope = checkpoint.signature;
    const payload = envelope.payload;
    const detailBase: SignedCheckpointVerificationDetail = {
      checkpointIndex: payload.checkpointIndex,
      eventIndex: payload.eventIndex,
      valid: false,
    };

    if (payload.version !== SIGNED_CHECKPOINT_FORMAT_VERSION) {
      return fail(
        { ...detailBase, reason: `Unsupported payload version: ${payload.version}` },
        `Unsupported signed checkpoint payload version: ${payload.version}`,
        payload.eventIndex
      );
    }

    if (payload.poswIterations !== POSW_ITERATIONS) {
      return fail(
        { ...detailBase, reason: `poswIterations mismatch: ${payload.poswIterations}` },
        `Signed checkpoint poswIterations mismatch: expected ${POSW_ITERATIONS}, got ${payload.poswIterations}`,
        payload.eventIndex
      );
    }

    if (initialEventChainHash && payload.initialEventChainHash !== initialEventChainHash) {
      return fail(
        { ...detailBase, reason: 'initialEventChainHash mismatch' },
        'Signed checkpoint initialEventChainHash does not match proof root',
        payload.eventIndex
      );
    }

    if (sessionId === null) {
      sessionId = payload.sessionId;
      firstSeenAt = payload.firstSeenAt;
    } else {
      if (payload.sessionId !== sessionId) {
        return fail(
          { ...detailBase, reason: 'sessionId mismatch across checkpoints' },
          'Signed checkpoints contain inconsistent sessionId',
          payload.eventIndex
        );
      }
      if (payload.firstSeenAt !== firstSeenAt) {
        return fail(
          { ...detailBase, reason: 'firstSeenAt mismatch across checkpoints' },
          'Signed checkpoints contain inconsistent firstSeenAt',
          payload.eventIndex
        );
      }
    }

    if (payload.checkpointIndex <= previousCheckpointIndex) {
      return fail(
        { ...detailBase, reason: 'checkpointIndex not strictly increasing' },
        `Signed checkpoint checkpointIndex not strictly increasing at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }
    if (payload.eventIndex <= previousEventIndex) {
      return fail(
        { ...detailBase, reason: 'eventIndex not strictly increasing' },
        `Signed checkpoint eventIndex not strictly increasing at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    const serverTs = Date.parse(payload.serverTimestamp);
    if (!Number.isFinite(serverTs)) {
      return fail(
        { ...detailBase, reason: 'invalid serverTimestamp' },
        `Signed checkpoint serverTimestamp is not a valid ISO date at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }
    if (serverTs <= previousServerTimestamp) {
      return fail(
        { ...detailBase, reason: 'serverTimestamp not strictly increasing' },
        `Signed checkpoint serverTimestamp not strictly increasing at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    const clientTs = Date.parse(payload.clientTimestamp);
    if (!Number.isFinite(clientTs)) {
      return fail(
        { ...detailBase, reason: 'invalid clientTimestamp' },
        `Signed checkpoint clientTimestamp is not a valid ISO date at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    if (payload.previousSignedCheckpointHash !== previousPayloadHash) {
      return fail(
        { ...detailBase, reason: 'previousSignedCheckpointHash mismatch' },
        `Signed checkpoint previousSignedCheckpointHash does not chain at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    const event = events[payload.eventIndex];
    if (!event) {
      return fail(
        { ...detailBase, reason: 'eventIndex out of bounds' },
        `Signed checkpoint points to missing event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }
    if (event.hash !== payload.chainHash) {
      return fail(
        { ...detailBase, reason: 'chainHash mismatch with event' },
        `Signed checkpoint chainHash does not match event hash at ${payload.eventIndex}`,
        payload.eventIndex
      );
    }
    if (checkpoint.hash !== payload.chainHash) {
      return fail(
        { ...detailBase, reason: 'chainHash mismatch with enclosing checkpoint' },
        `Signed checkpoint chainHash disagrees with its enclosing CheckpointData.hash at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }
    if (checkpoint.contentHash !== payload.contentHash) {
      return fail(
        { ...detailBase, reason: 'contentHash mismatch with enclosing checkpoint' },
        `Signed checkpoint contentHash disagrees with its enclosing CheckpointData.contentHash at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    const sigResult = await verifyCheckpointSignature(envelope, registry);
    if (!sigResult.valid) {
      return fail(
        { ...detailBase, reason: sigResult.reason ?? 'signature invalid' },
        sigResult.reason ?? `Signed checkpoint signature invalid at event ${payload.eventIndex}`,
        payload.eventIndex
      );
    }

    const detail: SignedCheckpointVerificationDetail = { ...detailBase, valid: true };
    const entry = sigResult.registryEntry;
    if (entry) {
      if (entry.validUntil && Date.parse(entry.validUntil) < serverTs) {
        return fail(
          { ...detailBase, reason: `key ${entry.keyId} expired before serverTimestamp` },
          `Signed checkpoint key ${entry.keyId} validUntil is before serverTimestamp at event ${payload.eventIndex}`,
          payload.eventIndex
        );
      }
      if (entry.revokedAt) {
        const revokedTs = Date.parse(entry.revokedAt);
        if (Number.isFinite(revokedTs) && serverTs >= revokedTs) {
          return fail(
            { ...detailBase, reason: `key ${entry.keyId} revoked before serverTimestamp` },
            `Signed checkpoint key ${entry.keyId} was revoked at or before serverTimestamp at event ${payload.eventIndex}`,
            payload.eventIndex
          );
        }
        detail.warning = 'key-revoked-but-trusted-by-time';
      } else if (entry.status === 'revoked') {
        // revokedAt が無いまま status='revoked' は安全側で拒否
        return fail(
          { ...detailBase, reason: `key ${entry.keyId} revoked without revokedAt` },
          `Signed checkpoint key ${entry.keyId} status is 'revoked' but revokedAt is missing`,
          payload.eventIndex
        );
      }
    }

    if (firstClientTs === null) firstClientTs = clientTs;
    lastClientTs = clientTs;
    if (firstServerTs === null) firstServerTs = serverTs;
    lastServerTs = serverTs;

    details.push(detail);
    previousPayloadHash = await hashSignedCheckpointPayload(payload);
    previousCheckpointIndex = payload.checkpointIndex;
    previousEventIndex = payload.eventIndex;
    previousServerTimestamp = serverTs;
  }

  return {
    valid: true,
    anchored: true,
    details,
    coverage: computeCoverage(events, signedCheckpoints),
    temporal: computeTemporal(firstClientTs, lastClientTs, firstServerTs, lastServerTs),
  };
}

function computeCoverage(
  events: StoredEvent[],
  signedCheckpoints: Array<CheckpointData & { signature: SignedCheckpointEnvelope }>
): SignedCheckpointsVerificationResult['coverage'] {
  const signedCount = signedCheckpoints.length;
  if (signedCount === 0) {
    return { signedCount: 0, lastSignedEventIndex: null, coverageRatio: 0 };
  }
  const lastSignedEventIndex = signedCheckpoints[signedCheckpoints.length - 1]!.signature.payload.eventIndex;
  const total = events.length;
  const coverageRatio = total > 0 ? Math.min(1, (lastSignedEventIndex + 1) / total) : 0;
  return { signedCount, lastSignedEventIndex, coverageRatio };
}

function computeTemporal(
  firstClientTs: number | null,
  lastClientTs: number | null,
  firstServerTs: number | null,
  lastServerTs: number | null
): SignedCheckpointsVerificationResult['temporal'] {
  if (
    firstClientTs === null ||
    lastClientTs === null ||
    firstServerTs === null ||
    lastServerTs === null
  ) {
    return null;
  }
  const serverSpanMs = Math.max(0, lastServerTs - firstServerTs);
  const clientSpanMs = Math.max(0, lastClientTs - firstClientTs);
  const ratio = clientSpanMs > 0 ? serverSpanMs / clientSpanMs : null;
  const postHocSuspected =
    (ratio !== null && ratio < POST_HOC_RATIO_THRESHOLD) ||
    (serverSpanMs < POST_HOC_MIN_SERVER_SPAN_MS && clientSpanMs > POST_HOC_MIN_CLIENT_SPAN_MS);
  return { serverSpanMs, clientSpanMs, ratio, postHocSuspected };
}

/**
 * proof から signed checkpoint を抽出して検証する高レベルラッパ。
 * 呼び出し側 (verifier worker / verify-cli) はこちらを使う。
 */
export async function verifyProofSignedCheckpoints(
  proof: Pick<ExportedProof, 'proof' | 'typingProofData' | 'checkpoints'>,
  options?: VerifySignedCheckpointsOptions
): Promise<SignedCheckpointsVerificationResult> {
  return verifySignedCheckpoints(
    proof.proof.events,
    proof.checkpoints,
    proof.typingProofData.initialEventChainHash ?? null,
    options
  );
}
