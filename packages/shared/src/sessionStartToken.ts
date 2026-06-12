/**
 * セッション開始トークン (ADR-0017) の作成・検証ロジック。
 *
 * 役割:
 * - createSessionStartToken: Workers が Turnstile 検証後に ECDSA-P256 で署名したトークンを発行
 * - validateSessionStartInput: untrusted な POST body の検証 (Workers 入力バリデーション)
 * - verifySessionStartToken: registry-only でトークン署名を検証 (C1 = ADR の registry-only 信頼)
 * - computeAnchoredChainRoot: root = SHA256(fp ‖ localNonce ‖ serverNonce) の単一ソース
 *
 * 署名鍵は checkpoint と同一系統 (CHECKPOINT_PUBLIC_KEYS / workers getSigningKey) を流用する。
 * 信頼アンカーは常に registry: 未登録 keyId は拒否し、攻撃者の自己署名トークンを valid にしない
 * (さもないと serverNonce を任意に偽造して root アンカーを無効化できる)。
 */

import type {
  SessionStartToken,
  SessionStartTokenPayload,
  SessionStartTokenVerificationResult,
} from './types/sessionStartToken.js';
import { POSW_ITERATIONS, SESSION_TOKEN_FORMAT_VERSION } from './version.js';
import { computeHash, deterministicStringify } from './utils/hashUtils.js';
import {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
  type CheckpointPublicKey,
} from './checkpointKeys/index.js';

/** SHA-256 を hex 文字列で表したときの正規表現 (64 桁の小文字 hex) */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** sessionId の許容最大長 (UUID 等で十分。API 濫用対策) */
const MAX_ID_LENGTH = 200;

/**
 * casual / class の anchored chain root を計算する単一ソース。
 *   root = SHA256(fingerprintHash ‖ localNonce ‖ serverNonce)
 *
 * 注: この連結式は HashChainManager.generateAnchoredInitialHash の inline 実装と**必ず一致**させる
 * こと (verifier はこちらで root を再計算する)。両者の一致はテストで担保する。
 * exam (ADR-0006) は別式 (computeExamChainRoot) で、serverNonce を足さない (ADR-0017 のスコープ外)。
 */
export async function computeAnchoredChainRoot(
  fingerprintHash: string,
  localNonce: string,
  serverNonce: string
): Promise<string> {
  return computeHash(fingerprintHash + localNonce + serverNonce);
}

/**
 * セッション開始トークン発行時にクライアントが提供する入力 (untrusted)。
 * `serverNonce` / `issuedAt` / Turnstile 結果はサーバ側で確定するためここには含めない。
 */
export interface SessionStartInput {
  sessionId: string;
  fingerprintHash: string;
}

/** サーバ側で確定するコンテキスト (serverNonce / issuedAt / Turnstile 結果)。 */
export interface SessionStartServerContext {
  serverNonce: string;
  issuedAt: string;
  turnstileVerified: boolean;
  hostname: string | null;
  action: string | null;
}

export interface SessionStartSigner {
  keyId: string;
  privateKey: CryptoKey;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
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
 * セッション開始トークンを作成 (canonical form で署名)。
 * Workers の session/start エンドポイントから呼ぶ。署名 cp と同じシリアライズ規約を共有する。
 */
export async function createSessionStartToken(
  input: SessionStartInput,
  serverContext: SessionStartServerContext,
  signer: SessionStartSigner
): Promise<SessionStartToken> {
  const payload: SessionStartTokenPayload = {
    version: SESSION_TOKEN_FORMAT_VERSION,
    sessionId: input.sessionId,
    serverNonce: serverContext.serverNonce,
    fingerprintHash: input.fingerprintHash,
    issuedAt: serverContext.issuedAt,
    turnstileVerified: serverContext.turnstileVerified,
    hostname: serverContext.hostname,
    action: serverContext.action,
    poswIterations: POSW_ITERATIONS,
  };

  const signingInput = new TextEncoder().encode(deterministicStringify(payload));
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.privateKey,
    signingInput as unknown as ArrayBuffer
  );

  return {
    payload,
    signature: bytesToHex(new Uint8Array(sigBuffer)),
    keyId: signer.keyId,
    algorithm: 'ECDSA-P256',
  };
}

/**
 * untrusted な session/start POST body を検証する (Workers 入力バリデーション)。
 * turnstileToken は別途 verifyTurnstile で検証するため、ここでは sessionId / fingerprintHash を見る。
 */
export function validateSessionStartInput(
  raw: unknown
): { ok: true; input: SessionStartInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'Input must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  const sessionId = obj.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'Missing or invalid sessionId' };
  }
  if (sessionId.length > MAX_ID_LENGTH) {
    return { ok: false, reason: `sessionId exceeds max length (${MAX_ID_LENGTH})` };
  }

  const fingerprintHash = obj.fingerprintHash;
  if (typeof fingerprintHash !== 'string' || !SHA256_HEX.test(fingerprintHash)) {
    return { ok: false, reason: 'fingerprintHash must be a 64-char lowercase hex SHA-256' };
  }

  return { ok: true, input: { sessionId, fingerprintHash } };
}

/**
 * セッション開始トークンの ECDSA-P256 署名を検証する。**信頼アンカーは registry のみ** (C1)。
 * 鍵の有効期間 / 失効も `issuedAt` を anchor に判定する (署名 cp と同じ規約)。
 *
 * 注: ここではトークン**自体**の整合性 (署名・鍵・version) のみを見る。serverNonce 込みの
 * root 再計算や sessionId↔署名 cp 突合は verifyInitialHashRoot / verifyProofFile が担う。
 */
export async function verifySessionStartToken(
  token: SessionStartToken,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): Promise<SessionStartTokenVerificationResult> {
  if (token.payload.version !== SESSION_TOKEN_FORMAT_VERSION) {
    return { valid: false, reason: `Unsupported session token version: ${token.payload.version}` };
  }
  if (token.payload.poswIterations !== POSW_ITERATIONS) {
    return {
      valid: false,
      reason: `Session token poswIterations mismatch: expected ${POSW_ITERATIONS}, got ${token.payload.poswIterations}`,
    };
  }
  if (token.algorithm !== 'ECDSA-P256') {
    return { valid: false, reason: `Unsupported algorithm: ${token.algorithm}` };
  }

  // 信頼アンカーは registry。未登録 keyId は拒否 (自己署名トークンを valid にしない)。
  const entry = findCheckpointPublicKey(token.keyId, registry) ?? null;
  if (!entry) {
    return { valid: false, reason: `Unknown keyId: ${token.keyId}` };
  }

  const issuedTs = Date.parse(token.payload.issuedAt);
  if (!Number.isFinite(issuedTs)) {
    return { valid: false, reason: 'Session token issuedAt is not a valid ISO date', keyId: entry.keyId };
  }

  // 鍵の有効期間 / 失効を issuedAt を anchor に判定 (署名 cp と同方針)。
  const validFromTs = Date.parse(entry.validFrom);
  if (Number.isFinite(validFromTs) && issuedTs < validFromTs) {
    return { valid: false, reason: `key ${entry.keyId} validFrom is after issuedAt`, keyId: entry.keyId };
  }
  if (entry.validUntil && Date.parse(entry.validUntil) < issuedTs) {
    return { valid: false, reason: `key ${entry.keyId} validUntil is before issuedAt`, keyId: entry.keyId };
  }
  if (entry.revokedAt) {
    const revokedTs = Date.parse(entry.revokedAt);
    if (Number.isFinite(revokedTs) && issuedTs >= revokedTs) {
      return { valid: false, reason: `key ${entry.keyId} was revoked at or before issuedAt`, keyId: entry.keyId };
    }
  } else if (entry.status === 'revoked') {
    return { valid: false, reason: `key ${entry.keyId} status is 'revoked' but revokedAt is missing`, keyId: entry.keyId };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      entry.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  } catch {
    return { valid: false, reason: 'Failed to import registry public key', keyId: entry.keyId };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToUint8Array(token.signature);
  } catch {
    return { valid: false, reason: 'Malformed signature hex', keyId: entry.keyId };
  }

  const signingInput = new TextEncoder().encode(deterministicStringify(token.payload));
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signatureBytes as unknown as ArrayBuffer,
      signingInput as unknown as ArrayBuffer
    );
  } catch {
    return { valid: false, reason: 'Signature verification error', keyId: entry.keyId };
  }

  if (!valid) {
    return { valid: false, reason: 'Session token signature is invalid', keyId: entry.keyId };
  }
  return { valid: true, keyId: entry.keyId };
}
