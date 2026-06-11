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

// --- ADR-0016: anchoring 密度の保守的閾値 ---
// cadence は CheckpointManager のハイブリッドトリガ (100 events OR 10,000 ms) に同期させる。
// 正規セッションでは時間トリガにより署名 cp が最大でも ~100 events / ~10s 間隔で打たれるはずなので、
// その 5 倍を「疎」と判定する保守的下限に採る。5 倍未満のギャップは正規の signing 失敗 (ネットワーク瞬断)
// と区別しにくいため罰さない。閾値はサンプルログが無い現状の安全側の置きで、実ログ収集後に要調整。
// TODO(ADR-0016): tune MAX_ANCHOR_GAP_* with real session logs.
const MAX_ANCHOR_GAP_EVENTS = 5 * 100; // 500 events
const MAX_ANCHOR_GAP_SERVER_MS = 5 * 10_000; // 50s
const MAX_FIRST_ANCHOR_LATENCY_EVENTS = 500; // events before the first signed checkpoint

/** SHA-256 を hex 文字列で表したときの正規表現 (64 桁の小文字 hex) */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** sessionId / tabId の許容最大長 (UUID 等で十分。署名 API の濫用対策) */
const MAX_ID_LENGTH = 200;
/** clientTimestamp (ISO 8601) の許容最大長 */
const MAX_TIMESTAMP_LENGTH = 40;
/** checkpointIndex / eventIndex / totalEventsSincePrevious の上限 (整数オーバーフロー/濫用対策) */
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

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

  // sessionId / tabId: 任意のクライアント生成文字列だが、署名 API なので
  // 非空かつ最大長で縛る (DoS / KV キー肥大化対策)。
  for (const k of ['sessionId', 'tabId'] as const) {
    const v = obj[k];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, reason: `Missing or invalid ${k}` };
    }
    if (v.length > MAX_ID_LENGTH) {
      return { ok: false, reason: `${k} exceeds max length (${MAX_ID_LENGTH})` };
    }
  }

  // ハッシュ系フィールドは SHA-256 hex (64 桁) でなければならない。
  // 「非空文字列」だけだと任意の値で署名 API を叩けてしまう。
  for (const k of ['initialEventChainHash', 'chainHash', 'contentHash'] as const) {
    if (typeof obj[k] !== 'string' || !SHA256_HEX.test(obj[k] as string)) {
      return { ok: false, reason: `${k} must be a 64-char lowercase hex SHA-256` };
    }
  }

  const intFields = ['checkpointIndex', 'eventIndex', 'totalEventsSincePrevious'] as const;
  for (const k of intFields) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_SAFE_COUNT) {
      return { ok: false, reason: `Missing or invalid ${k}` };
    }
  }
  if (
    obj.previousSignedCheckpointHash !== null &&
    (typeof obj.previousSignedCheckpointHash !== 'string' ||
      !SHA256_HEX.test(obj.previousSignedCheckpointHash as string))
  ) {
    return { ok: false, reason: 'previousSignedCheckpointHash must be null or 64-hex string' };
  }
  if (
    typeof obj.clientTimestamp !== 'string' ||
    obj.clientTimestamp.length === 0 ||
    obj.clientTimestamp.length > MAX_TIMESTAMP_LENGTH ||
    Number.isNaN(Date.parse(obj.clientTimestamp))
  ) {
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
 * envelope の keyId から検証用 CryptoKey を解決する。
 *
 * **信頼アンカーは常に registry**。keyId が registry に解決できない鍵は信頼しない
 * (exam/examPackage.ts の `verifyExamPackageSignature` と同方針)。同梱 `publicKeyJwk` は
 * long-term verifiability 用の控えであって信頼の源ではない: これを信頼源にすると攻撃者が
 * 自分の鍵ペアを同梱して自己署名でき、署名 cp の時刻アンカー (= 唯一の偽造不能要素) の
 * 意味が消える。よって:
 *   - registry 未登録の keyId は (埋め込み鍵があっても) `Unknown keyId` として弾く
 *   - registry にある場合のみ、同梱 `publicKeyJwk` があれば JWK 一致を必須にする (すり替え検出)
 *   - 署名は常に registry の公開鍵で検証する
 */
export async function resolveCheckpointPublicKey(
  envelope: SignedCheckpointEnvelope,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): Promise<
  | { ok: true; cryptoKey: CryptoKey; registryEntry: CheckpointPublicKey }
  | { ok: false; reason: string }
> {
  // 信頼アンカーは registry。未登録 keyId は (埋め込み鍵があっても) 信頼しない。
  const registryEntry = findCheckpointPublicKey(envelope.keyId, registry) ?? null;
  if (!registryEntry) {
    return { ok: false, reason: `Unknown keyId: ${envelope.keyId}` };
  }

  // 同梱 publicKeyJwk があれば registry エントリと一致必須 (埋め込み鍵すり替えの検出)。
  // 一致チェック専用であって信頼の源にはしない。署名は常に registry の公開鍵で検証する。
  if (envelope.publicKeyJwk) {
    const sameJwk =
      deterministicStringify(envelope.publicKeyJwk) ===
      deterministicStringify(registryEntry.publicKeyJwk);
    if (!sameJwk) {
      return { ok: false, reason: 'Embedded public key does not match registry entry' };
    }
  }

  if (envelope.algorithm !== 'ECDSA-P256') {
    return { ok: false, reason: `Unsupported algorithm: ${envelope.algorithm}` };
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    registryEntry.publicKeyJwk,
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

  // signature が不正な hex (奇数長など) でも throw せず valid:false を返す。
  // これがないと hexToUint8Array が throw し、verifyProofFile (CLI) のように
  // 例外を握らない呼び出し側で検証全体がクラッシュする (Web worker は try/catch
  // で握っており挙動が分かれていた)。ここで吸収して両経路の挙動を揃える。
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToUint8Array(envelope.signature);
  } catch {
    return { valid: false, reason: 'Malformed signature hex', registryEntry: resolved.registryEntry };
  }

  const signingInput = new TextEncoder().encode(deterministicStringify(envelope.payload));

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      resolved.cryptoKey,
      signatureBytes as unknown as ArrayBuffer,
      signingInput as unknown as ArrayBuffer
    );
  } catch {
    // 鍵長と signature 長の不整合などで verify 自体が throw するケースも吸収
    return { valid: false, reason: 'Signature verification error', registryEntry: resolved.registryEntry };
  }

  return { valid, registryEntry: resolved.registryEntry };
}

interface VerifySignedCheckpointsOptions {
  registry?: readonly CheckpointPublicKey[];
  /**
   * true のとき anchoring 密度が保守的閾値を下回る (density.sparse) 場合に valid=false にする (ADR-0016)。
   * 既定 false = density は計測のみで、warning 表示は呼び出し側の責務。exam / 採点ポリシーで opt-in する。
   * 未アンカー (anchored=false) のときは density=null なので、この gate は影響しない
   * (ADR-0004「未アンカーは valid のまま」を維持する)。
   */
  requireAnchorDensity?: boolean;
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
    density: null,
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
      density: computeDensity(events, signedCheckpoints),
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
      const validFromTs = Date.parse(entry.validFrom);
      if (Number.isFinite(validFromTs) && serverTs < validFromTs) {
        return fail(
          { ...detailBase, reason: `key ${entry.keyId} not yet valid at serverTimestamp` },
          `Signed checkpoint key ${entry.keyId} validFrom is after serverTimestamp at event ${payload.eventIndex}`,
          payload.eventIndex
        );
      }
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

  const density = computeDensity(events, signedCheckpoints);
  const coverage = computeCoverage(events, signedCheckpoints);
  const temporal = computeTemporal(firstClientTs, lastClientTs, firstServerTs, lastServerTs);

  // 全 envelope は署名・連鎖整合とも合格。ここで anchoring 密度 gate を任意適用する (ADR-0016)。
  // strict (exam/採点で opt-in) のときだけ、疎な anchoring を valid=false に落とす。
  // 既定は valid=true のまま density を返し、呼び出し側が warning として表示する。
  if (options.requireAnchorDensity && density?.sparse) {
    return {
      valid: false,
      anchored: true,
      details,
      coverage,
      temporal,
      density,
      reason: 'Signed checkpoint anchoring is too sparse for the claimed session (density gate)',
    };
  }

  return {
    valid: true,
    anchored: true,
    details,
    coverage,
    temporal,
    density,
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

/**
 * anchoring 密度 (ADR-0016) を計量する。
 *
 * 「末尾 1 個の署名 cp で長いチェーンをアンカー済みに見せる」手口は coverageRatio / postHoc では
 * 捕まらない (単一 cp は coverageRatio 最大 1.0・postHocSuspected=false)。そこで署名 cp が指す
 * eventIndex / serverTimestamp の **間隔** を見る。
 *
 * - event ギャップ: 先頭 (event0 → 初アンカー) / 連続アンカー間 / 末尾 (最終アンカー → 最終 event)。
 *   単一末尾 cp は先頭ギャップが、単一先頭 cp は末尾ギャップが大きくなり、どちらの偏りも検出できる。
 * - server ギャップ: 先頭 (firstSeenAt → 初アンカー、現状 ~0) / 連続アンカー間。
 *   末尾は最終 event のサーバ時刻が無いため評価しない (event ギャップでカバーする)。
 *
 * 誤検知回避: signedCount===0 は対象外 (null を返す)。閾値は cadence の 5 倍に置き、短い正規
 * セッション (例 50 events / 数分) は時間トリガで密に打たれるため sparse にならない。
 */
function computeDensity(
  events: StoredEvent[],
  signedCheckpoints: Array<CheckpointData & { signature: SignedCheckpointEnvelope }>
): SignedCheckpointsVerificationResult['density'] {
  if (signedCheckpoints.length === 0) return null;

  // 署名 cp の (eventIndex, serverTimestamp) を eventIndex 昇順で取り出す。
  // 成功パスでは検証器が厳密増加を保証済みだが、fail パスからも呼ばれるため防御的にソートする。
  const anchors = signedCheckpoints
    .map((cp) => ({
      eventIndex: cp.signature.payload.eventIndex,
      serverMs: Date.parse(cp.signature.payload.serverTimestamp),
    }))
    .filter((a) => Number.isInteger(a.eventIndex) && a.eventIndex >= 0)
    .sort((a, b) => a.eventIndex - b.eventIndex);

  if (anchors.length === 0) return null;

  const n = events.length;
  const firstAnchorEventIndex = anchors[0]!.eventIndex;
  const firstAnchorLatencyEvents = firstAnchorEventIndex;

  // firstSeenAt は全 envelope で一致する (検証器が要求)。先頭の署名 cp から読む。
  const firstSeenRaw = signedCheckpoints[0]!.signature.payload.firstSeenAt;
  const firstSeenMs = firstSeenRaw ? Date.parse(firstSeenRaw) : NaN;
  const firstAnchorServerMs = anchors[0]!.serverMs;
  const firstAnchorLatencyServerMs =
    Number.isFinite(firstSeenMs) && Number.isFinite(firstAnchorServerMs)
      ? Math.max(0, firstAnchorServerMs - firstSeenMs)
      : null;

  // event ギャップ: 先頭 / 連続アンカー間 / 末尾。
  let maxGapEvents = firstAnchorEventIndex; // 先頭ギャップ (event0 → 初アンカー)
  for (let i = 1; i < anchors.length; i++) {
    maxGapEvents = Math.max(maxGapEvents, anchors[i]!.eventIndex - anchors[i - 1]!.eventIndex);
  }
  const lastAnchorEventIndex = anchors[anchors.length - 1]!.eventIndex;
  maxGapEvents = Math.max(maxGapEvents, Math.max(0, n - 1 - lastAnchorEventIndex)); // 末尾ギャップ

  // server ギャップ: 先頭 (firstSeenAt → 初アンカー) / 連続アンカー間。
  let maxGapServerMs = 0;
  if (Number.isFinite(firstSeenMs) && Number.isFinite(firstAnchorServerMs)) {
    maxGapServerMs = Math.max(maxGapServerMs, firstAnchorServerMs - firstSeenMs);
  }
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!.serverMs;
    const cur = anchors[i]!.serverMs;
    if (Number.isFinite(prev) && Number.isFinite(cur)) {
      maxGapServerMs = Math.max(maxGapServerMs, cur - prev);
    }
  }

  const sparse =
    maxGapEvents > MAX_ANCHOR_GAP_EVENTS ||
    maxGapServerMs > MAX_ANCHOR_GAP_SERVER_MS ||
    firstAnchorLatencyEvents > MAX_FIRST_ANCHOR_LATENCY_EVENTS;

  return {
    firstAnchorEventIndex,
    firstAnchorLatencyEvents,
    firstAnchorLatencyServerMs,
    maxGapEvents,
    maxGapServerMs,
    sparse,
  };
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
