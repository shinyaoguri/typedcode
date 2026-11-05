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
import type { CheckpointData, ExportedProof, StoredEvent } from './types/proof.js';
import { POSW_ITERATIONS, SIGNED_CHECKPOINT_FORMAT_VERSION } from './version.js';
import { computeHash, deterministicStringify } from './utils/hashUtils.js';
import {
  CHECKPOINT_PUBLIC_KEYS,
  checkRegistryKeyValidityAt,
  findCheckpointPublicKey,
  type CheckpointPublicKey,
} from './checkpointKeys/index.js';

// post-hoc と密度 (下) の閾値は system-spec §10 の定数。境界のテスト (`signedCheckpointThresholds.test.ts`) が
// 値を書き写さずに参照できるよう export する (index には出さない。公開 API ではない)。

// --- #320: post-hoc (事後一括署名) の許容差 ---
// 判定: 署名 cp (と、root が検証済みなら token の issuedAt を基点に) の任意の 2 点 k < j で
//   (e_j − e_k) − (s_j − s_k) ≤ max(POST_HOC_TOLERANCE_MS, POST_HOC_TOLERANCE_RATIO × (s_j − s_k))
// を要求する (e = 署名 cp が指すイベントの `event.timestamp`、s = `serverTimestamp`)。e はハッシュ対象の
// 単調時計 (performance.now() − startTime) なので、正直な proof ではイベント時刻の進みがサーバ時刻の進みを超えない。
// - 60s: 署名の遅れ。fetch のタイムアウト 10s (editor の WORKERS_FETCH_TIMEOUT_MS) + backoff 1+2+4+8+16s
//   ≒ 5 回目の再送まで、と PoSW の処理待ち
// - 1%: 単調時計とサーバ時計の進み方の差 (NTP の slew は最大 500ppm = 0.05%。その 20 倍)
// 隣接ペアごとではなく累積 (任意の 2 点) で照合するので、攻撃者が水増しできるのはセッション全体で
// max(60s, スパンの 1%) の一回分 (ペアごとだと cp の数 × 許容差まで水増しできる)。
export const POST_HOC_TOLERANCE_MS = 60 * 1000;
export const POST_HOC_TOLERANCE_RATIO = 0.01;

// --- ADR-0016: anchoring 密度の保守的閾値 ---
// cadence は CheckpointManager のハイブリッドトリガ (100 events OR 10,000 ms) に同期させる。
// 正規セッションでは時間トリガにより署名 cp が最大でも ~100 events / ~10s 間隔で打たれるはずなので、
// その 5 倍を「疎」と判定する保守的下限に採る。5 倍未満のギャップは正規の signing 失敗 (ネットワーク瞬断)
// と区別しにくいため罰さない。閾値はサンプルログが無い現状の安全側の置きで、実ログ収集後に要調整。
// TODO(ADR-0016): tune MAX_ANCHOR_GAP_* with real session logs.
export const MAX_ANCHOR_GAP_EVENTS = 5 * 100; // 500 events
/**
 * 連続する署名 cp 間のサーバ時刻の空白のうち、イベント時刻で説明できない分 ((s_j − s_{j−1}) − (e_j − e_{j−1}))
 * の上限 (#320)。考え込んで無操作の区間は Δe ≈ Δs なので空白に数えない。先頭 (firstSeenAt → 初アンカー) は
 * イベント時刻の対応が無いので生の差で見る。
 */
export const MAX_ANCHOR_GAP_SERVER_MS = 5 * 10_000; // 50s
/**
 * 連続する署名 cp k, k+1 の間にある (cp を持たない) イベント x の e_x − e_k の上限 (#320)。正直な editor は
 * 最後の cp から 10s 経つと次のイベントで cp を作る (`CheckpointManager.shouldCreateCheckpoint`) ので、
 * 署名で挟まれていないイベントは直前の cp から ~10s 以内に収まる。その 5 倍。上の空白 (A) だけだと、
 * 実時間で待ってオフラインで合成したイベントを待った時間に散らし、末尾 1 個だけ署名させる形が通ってしまう。
 */
export const MAX_UNANCHORED_EVENT_SPAN_MS = 5 * 10_000; // 50s
export const MAX_FIRST_ANCHOR_LATENCY_EVENTS = 500; // events before the first signed checkpoint

/** SHA-256 を hex 文字列で表したときの正規表現 (64 桁の小文字 hex) */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** sessionId / tabId の許容最大長 (UUID 等で十分。署名 API の濫用対策) */
export const MAX_ID_LENGTH = 200;
/**
 * sessionId / tabId の許容文字種 (#297)。Workers の KV キー `session:{sessionId}:{tabId}` に
 * そのまま埋め込まれるので、区切り文字 `:` を締め出して `a:b`/`c` と `a`/`b:c` の衝突を塞ぐ。
 * ASCII 限定にすることで MAX_ID_LENGTH (文字数) がそのまま KV キーのバイト長上限 (512) 内に収まる。
 * editor の ID は crypto.randomUUID() なので常にこの集合に入る。
 * sessionStartToken.ts の validateSessionStartInput と同じ集合に揃えること (token の sessionId が
 * ここを通らないと、発行はできても署名できない sessionId が生まれる)。
 */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** clientTimestamp (ISO 8601) の許容最大長 */
export const MAX_TIMESTAMP_LENGTH = 40;
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
  // 非空かつ最大長で縛る (DoS / KV キー肥大化対策)。文字種も KV キーの区切りと衝突しない
  // allowlist に限る (#297)。
  for (const k of ['sessionId', 'tabId'] as const) {
    const v = obj[k];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, reason: `Missing or invalid ${k}` };
    }
    if (v.length > MAX_ID_LENGTH) {
      return { ok: false, reason: `${k} exceeds max length (${MAX_ID_LENGTH})` };
    }
    if (!ID_PATTERN.test(v)) {
      return { ok: false, reason: `${k} must match ${ID_PATTERN.source}` };
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
export async function hashSignedCheckpointPayload(payload: SignedCheckpointPayload): Promise<string> {
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
export function isIdempotentSigningRetry(input: SignedCheckpointInput, cached: SignedCheckpointPayload): boolean {
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
): Promise<{ ok: true; cryptoKey: CryptoKey; registryEntry: CheckpointPublicKey } | { ok: false; reason: string }> {
  // 信頼アンカーは registry。未登録 keyId は (埋め込み鍵があっても) 信頼しない。
  const registryEntry = findCheckpointPublicKey(envelope.keyId, registry) ?? null;
  if (!registryEntry) {
    return { ok: false, reason: `Unknown keyId: ${envelope.keyId}` };
  }

  // 同梱 publicKeyJwk があれば registry エントリと一致必須 (埋め込み鍵すり替えの検出)。
  // 一致チェック専用であって信頼の源にはしない。署名は常に registry の公開鍵で検証する。
  if (envelope.publicKeyJwk) {
    const sameJwk =
      deterministicStringify(envelope.publicKeyJwk) === deterministicStringify(registryEntry.publicKeyJwk);
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
   * 検証済みのセッション開始トークンの `issuedAt` (#320)。渡すと post-hoc の照合に基点
   * (e = events[0].timestamp, s = issuedAt) を足す。root が検証済み (`rootAnchored`) のときだけ渡すこと
   * (未検証の token の issuedAt は書き換えられる)。parse できない値は基点に使わない。
   *
   * ここ (低水準の `verifySignedCheckpoints`) では省略可にしている: 密度・署名の検査だけを見る呼び出し
   * (テストの大半) に基点は関係なく、省略は「基点なし」= 基点を足さない側に倒れるだけで判定を緩めない。
   * 本番の経路 (`verifyProofSignedCheckpoints`) では必須にして渡し忘れを型で止める。
   */
  sessionAnchorIssuedAt?: string | null;
}

/** `verifyProofSignedCheckpoints` の options。root アンカーの基点を渡し忘れないよう必須にする (#320)。 */
interface VerifyProofSignedCheckpointsOptions extends VerifySignedCheckpointsOptions {
  /** 検証済み token の `issuedAt`。root が検証済みでなければ null を渡す。 */
  sessionAnchorIssuedAt: string | null;
}

/** post-hoc の照合に使う 1 点 (#320)。eventMs は有限の数でなければ NaN。 */
interface TimedPoint {
  eventMs: number;
  serverMs: number;
}

/** 署名 cp 1 個ぶんの時刻 (#320)。clientMs は表示用の参考値 (判定に使わない)。 */
interface TimedAnchor extends TimedPoint {
  clientMs: number;
}

/**
 * イベント時刻 (`event.timestamp`、ハッシュ対象の相対 ms)。有限の数でなければ NaN を返す (#320)。
 * 改ざんならハッシュ (`verifyChain`) で落ちるが、ここ単体でも NaN を素通しさせず、呼び出し側が fail-closed に扱う。
 */
function eventTimeMs(event: StoredEvent | undefined): number {
  const ts = (event as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : NaN;
}

/** post-hoc 照合の許容差 (#320)。Δs が負 (基点の issuedAt が cp より後) なら絶対値の成分だけになる。 */
function postHocToleranceMs(serverDeltaMs: number): number {
  return Math.max(POST_HOC_TOLERANCE_MS, POST_HOC_TOLERANCE_RATIO * serverDeltaMs);
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
  // root が検証済みのときだけ呼び出し側が渡す token の issuedAt を、post-hoc 照合の基点にする (#320)。
  const issuedAtMs =
    typeof options.sessionAnchorIssuedAt === 'string' ? Date.parse(options.sessionAnchorIssuedAt) : NaN;
  const sessionAnchor: TimedPoint | null = Number.isFinite(issuedAtMs)
    ? { eventMs: eventTimeMs(events[0]), serverMs: issuedAtMs }
    : null;
  const signedCheckpoints = (checkpoints ?? []).filter(
    (cp): cp is CheckpointData & { signature: SignedCheckpointEnvelope } => !!cp.signature
  );

  const baseResult: SignedCheckpointsVerificationResult = {
    valid: false,
    anchored: false,
    details: [],
    coverage: computeCoverage(events, signedCheckpoints),
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
  // 検査を通った署名 cp の時刻 (post-hoc の照合用。#320)。
  const timedAnchors: TimedAnchor[] = [];

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
      temporal: computeTemporal(timedAnchors, sessionAnchor),
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
      // 鍵の有効期間 / 失効判定は checkpointKeys/keyValidity.ts に一本化 (#233)。
      // registry の日時が parse 不能なエントリは信頼しない (fail-closed)。
      const verdict = checkRegistryKeyValidityAt(entry, serverTs);
      if (!verdict.ok) {
        const at = `at event ${payload.eventIndex}`;
        switch (verdict.code) {
          case 'malformed-date':
            return fail(
              { ...detailBase, reason: `key ${entry.keyId} has an unparsable ${verdict.field} in the registry` },
              `Signed checkpoint key ${entry.keyId} has an unparsable ${verdict.field} in the registry ${at}`,
              payload.eventIndex
            );
          case 'not-yet-valid':
            return fail(
              { ...detailBase, reason: `key ${entry.keyId} not yet valid at serverTimestamp` },
              `Signed checkpoint key ${entry.keyId} validFrom is after serverTimestamp ${at}`,
              payload.eventIndex
            );
          case 'expired':
            return fail(
              { ...detailBase, reason: `key ${entry.keyId} expired before serverTimestamp` },
              `Signed checkpoint key ${entry.keyId} validUntil is before serverTimestamp ${at}`,
              payload.eventIndex
            );
          case 'revoked-before-anchor':
            return fail(
              { ...detailBase, reason: `key ${entry.keyId} revoked before serverTimestamp` },
              `Signed checkpoint key ${entry.keyId} was revoked at or before serverTimestamp ${at}`,
              payload.eventIndex
            );
          case 'revoked-without-revoked-at':
            return fail(
              { ...detailBase, reason: `key ${entry.keyId} revoked without revokedAt` },
              `Signed checkpoint key ${entry.keyId} status is 'revoked' but revokedAt is missing`,
              payload.eventIndex
            );
        }
      } else if (verdict.revokedAfterAnchor) {
        detail.warning = 'key-revoked-but-trusted-by-time';
      }
    }

    timedAnchors.push({ eventMs: eventTimeMs(event), serverMs: serverTs, clientMs: clientTs });

    details.push(detail);
    previousPayloadHash = await hashSignedCheckpointPayload(payload);
    previousCheckpointIndex = payload.checkpointIndex;
    previousEventIndex = payload.eventIndex;
    previousServerTimestamp = serverTs;
  }

  const density = computeDensity(events, signedCheckpoints);
  const coverage = computeCoverage(events, signedCheckpoints);
  const temporal = computeTemporal(timedAnchors, sessionAnchor);

  // 全 envelope は署名・連鎖整合とも合格。anchoring 密度 (ADR-0016) は計量して返すだけで、
  // ここでは valid を落とさない。疎な proof を不受理にする判定は受理ポリシー
  // (`acceptancePolicy.ts` の `anchor-density-sparse`, #296) へ移った。密度で valid を落とすと、
  // 「署名が改ざんされた」と「証拠が足りない」を機械的に見分けられなくなる。
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
  const total = events.length;
  if (signedCount === 0) {
    // 署名 cp が無ければ全イベントが未署名の末尾 (#295)。
    return {
      signedCount: 0,
      lastSignedEventIndex: null,
      coverageRatio: 0,
      unsignedTailEvents: total,
      terminalAnchored: false,
    };
  }
  const lastSignedEventIndex = signedCheckpoints[signedCheckpoints.length - 1]!.signature.payload.eventIndex;
  const coverageRatio = total > 0 ? Math.min(1, (lastSignedEventIndex + 1) / total) : 0;
  // 未署名の末尾 (#295): 最後の署名 cp より後のイベントはサーバ時刻の上界を持たない。
  // eventIndex が範囲外の cp (検証は失敗する) でも負の件数を出さない。
  const unsignedTailEvents = Math.max(0, total - 1 - lastSignedEventIndex);
  const terminalAnchored = lastSignedEventIndex === total - 1;
  return { signedCount, lastSignedEventIndex, coverageRatio, unsignedTailEvents, terminalAnchored };
}

/**
 * anchoring 密度 (ADR-0016) を計量する。
 *
 * 「末尾 1 個の署名 cp で長いチェーンをアンカー済みに見せる」手口は coverageRatio / postHoc では
 * 捕まらない (単一 cp は coverageRatio 最大 1.0・postHocSuspected=false)。そこで署名 cp が指す
 * eventIndex / serverTimestamp / イベント時刻の **間隔** を見る。
 *
 * - event ギャップ: 先頭 (event0 → 初アンカー) / 連続アンカー間 / 末尾 (最終アンカー → 最終 event)。
 *   単一末尾 cp は先頭ギャップが、単一先頭 cp は末尾ギャップが大きくなり、どちらの偏りも検出できる。
 * - 説明できないサーバ時刻の空白 (A, #320): 連続アンカー間の (Δs − Δe)。正直な無操作 (Δe ≈ Δs) は数えない。
 *   先頭 (firstSeenAt → 初アンカー、現状 ~0) はイベント時刻の対応が無いので生の差で含める。
 *   末尾は最終 event のサーバ時刻が無いため評価しない (event ギャップと terminalAnchored でカバーする)。
 * - 未アンカーのイベント時刻の幅 (B, #320): 連続アンカー k, k+1 の間のイベント x の e_x − e_k。
 *   最初のアンカーより前 (時間トリガは最初の cp の後にしか効かない) と最後のアンカーより後は対象外。
 * - 生のサーバ時刻のギャップ (`maxGapServerMs`) は表示用に残し、判定には使わない。
 *
 * イベント時刻が有限の数でないイベントは計量では飛ばし、判定は sparse に倒す (fail-closed)。
 *
 * 誤検知回避: signedCount===0 は対象外 (null を返す)。閾値は cadence の 5 倍に置き、短い正規
 * セッション (例 50 events / 数分) は時間トリガで密に打たれるため sparse にならない。
 */
function computeDensity(
  events: StoredEvent[],
  signedCheckpoints: Array<CheckpointData & { signature: SignedCheckpointEnvelope }>
): SignedCheckpointsVerificationResult['density'] {
  if (signedCheckpoints.length === 0) return null;

  // 署名 cp の (eventIndex, serverTimestamp, イベント時刻) を eventIndex 昇順で取り出す。
  // 成功パスでは検証器が厳密増加を保証済みだが、fail パスからも呼ばれるため防御的にソートする。
  const anchors = signedCheckpoints
    .map((cp) => ({
      eventIndex: cp.signature.payload.eventIndex,
      serverMs: Date.parse(cp.signature.payload.serverTimestamp),
    }))
    .filter((a) => Number.isInteger(a.eventIndex) && a.eventIndex >= 0)
    .sort((a, b) => a.eventIndex - b.eventIndex)
    .map((a) => ({ ...a, eventMs: eventTimeMs(events[a.eventIndex]) }));

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

  // サーバ時刻のギャップ: 先頭 (firstSeenAt → 初アンカー) は生の差で、生の値 (表示用) と (A) の両方に入れる。
  let maxGapServerMs = 0;
  let maxUnexplainedGapServerMs = 0;
  if (Number.isFinite(firstSeenMs) && Number.isFinite(firstAnchorServerMs)) {
    maxGapServerMs = Math.max(maxGapServerMs, firstAnchorServerMs - firstSeenMs);
    maxUnexplainedGapServerMs = maxGapServerMs;
  }
  let maxUnanchoredEventSpanMs = 0;
  // イベント時刻が有限の数でないイベントに当たったら判定を sparse に倒す (計量からは外す)。
  let eventTimeUnusable = false;
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!;
    const cur = anchors[i]!;
    if (Number.isFinite(prev.serverMs) && Number.isFinite(cur.serverMs)) {
      const serverGap = cur.serverMs - prev.serverMs;
      maxGapServerMs = Math.max(maxGapServerMs, serverGap);
      // (A) 連続アンカー間の、イベント時刻で説明できないサーバ時刻の空白。
      if (Number.isFinite(prev.eventMs) && Number.isFinite(cur.eventMs)) {
        maxUnexplainedGapServerMs = Math.max(maxUnexplainedGapServerMs, serverGap - (cur.eventMs - prev.eventMs));
      } else {
        eventTimeUnusable = true;
      }
    }
    // (B) 連続アンカーの間にあるイベントが、直前のアンカーからイベント時刻でどれだけ進んだか。
    const end = Math.min(cur.eventIndex, n);
    for (let x = prev.eventIndex + 1; x < end; x++) {
      const eventMs = eventTimeMs(events[x]);
      if (Number.isFinite(eventMs) && Number.isFinite(prev.eventMs)) {
        maxUnanchoredEventSpanMs = Math.max(maxUnanchoredEventSpanMs, eventMs - prev.eventMs);
      } else {
        eventTimeUnusable = true;
      }
    }
  }

  const sparse =
    eventTimeUnusable ||
    maxGapEvents > MAX_ANCHOR_GAP_EVENTS ||
    maxUnexplainedGapServerMs > MAX_ANCHOR_GAP_SERVER_MS ||
    maxUnanchoredEventSpanMs > MAX_UNANCHORED_EVENT_SPAN_MS ||
    firstAnchorLatencyEvents > MAX_FIRST_ANCHOR_LATENCY_EVENTS;

  return {
    firstAnchorEventIndex,
    firstAnchorLatencyEvents,
    firstAnchorLatencyServerMs,
    maxGapEvents,
    maxGapServerMs,
    maxUnexplainedGapServerMs,
    maxUnanchoredEventSpanMs,
    sparse,
  };
}

/**
 * post-hoc (事後一括署名) の疑いを、イベント時刻とサーバ時刻の照合で測る (#320)。
 *
 * 照合する点は検査を通った署名 cp と、渡されれば検証済み token の基点 (`sessionAnchor`、先頭に置く)。
 * 任意の 2 点 k < j で (e_j − e_k) − (s_j − s_k) ≤ max(60s, 1% × (s_j − s_k)) を要求する。
 * `clientTimestamp` は申告値なので判定に使わず、`clientSpanMs` / `ratio` は表示用の参考値として返すだけ。
 *
 * 全ペアの照合は O(n²) だが、許容差は絶対値 60s を下回らないので、全ペアのリードの最大
 * (= 各 j で d_j − min_{k<j} d_k、d = e − s。O(n)) が 60s 以下なら違反は無い。正直な proof はここで終わる。
 * 超えたときだけ全ペアを見る (相対の許容差はペアごとに違い、d の最小値との組だけ見ても同値にならない)。
 *
 * イベント時刻が有限の数でない点があれば、計量からは外し、判定は post-hoc 疑いに倒す (fail-closed)。
 */
function computeTemporal(
  anchors: readonly TimedAnchor[],
  sessionAnchor: TimedPoint | null
): SignedCheckpointsVerificationResult['temporal'] {
  if (anchors.length === 0) return null;
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  const serverSpanMs = Math.max(0, last.serverMs - first.serverMs);
  const clientSpanMs = Math.max(0, last.clientMs - first.clientMs);
  const ratio = clientSpanMs > 0 ? serverSpanMs / clientSpanMs : null;

  const timedAnchors = anchors.filter((a) => Number.isFinite(a.eventMs));
  const eventSpanMs =
    timedAnchors.length > 0
      ? Math.max(0, timedAnchors[timedAnchors.length - 1]!.eventMs - timedAnchors[0]!.eventMs)
      : 0;

  const allPoints: TimedPoint[] = sessionAnchor ? [sessionAnchor, ...anchors] : [...anchors];
  const points = allPoints.filter((p) => Number.isFinite(p.eventMs));
  let postHocSuspected = points.length !== allPoints.length;

  // 全ペアのリード (Δe − Δs) の最大。d = e − s の累積最小値との差で O(n)。
  let maxEventLeadMs = 0;
  let minD = Infinity;
  for (const p of points) {
    const d = p.eventMs - p.serverMs;
    maxEventLeadMs = Math.max(maxEventLeadMs, d - minD);
    minD = Math.min(minD, d);
  }

  if (!postHocSuspected && maxEventLeadMs > POST_HOC_TOLERANCE_MS) {
    outer: for (let j = 1; j < points.length; j++) {
      for (let k = 0; k < j; k++) {
        const serverDeltaMs = points[j]!.serverMs - points[k]!.serverMs;
        const lead = points[j]!.eventMs - points[k]!.eventMs - serverDeltaMs;
        if (lead > postHocToleranceMs(serverDeltaMs)) {
          postHocSuspected = true;
          break outer;
        }
      }
    }
  }

  return { serverSpanMs, clientSpanMs, ratio, eventSpanMs, maxEventLeadMs, postHocSuspected };
}

/**
 * proof から signed checkpoint を抽出して検証する高レベルラッパ。
 * 呼び出し側 (verifier worker / verify-cli) はこちらを使う。
 */
export async function verifyProofSignedCheckpoints(
  proof: Pick<ExportedProof, 'proof' | 'typingProofData' | 'checkpoints'>,
  options: VerifyProofSignedCheckpointsOptions
): Promise<SignedCheckpointsVerificationResult> {
  return verifySignedCheckpoints(
    proof.proof.events,
    proof.checkpoints,
    proof.typingProofData.initialEventChainHash ?? null,
    options
  );
}
