/**
 * /api/checkpoint/sign + /api/checkpoint/public-keys ハンドラ。
 *
 * 設計:
 * - サーバは最小限の KV 状態 (session:{sessionId}) のみ保持する。
 * - 厳密な単調性は verifier 側の連鎖チェックで保証。サーバ側は best-effort で
 *   非単調 / セッション上限超過を弾く。
 * - firstSeenAt は KV 初回書込時に確定し、それ以降は固定。verifier はすべての
 *   envelope で firstSeenAt が一致することを要求するので、sessionId 乗っ取りに
 *   対する追加の防御線となる。
 */

import {
  CHECKPOINT_PUBLIC_KEYS,
  createSignedCheckpointEnvelope,
  findCheckpointPublicKey,
  isIdempotentSigningRetry,
  validateSignedCheckpointInput,
} from '@typedcode/shared/checkpoint';
import type { SignedCheckpointEnvelope } from '@typedcode/shared/checkpoint';

export interface CheckpointEnv {
  CHECKPOINT_SESSIONS: KVNamespace;
  /** ECDSA-P256 秘密鍵 JWK を JSON 文字列で注入 */
  CHECKPOINT_SIGNING_KEY_JWK?: string;
  /** 秘密鍵に対応する keyId (CHECKPOINT_PUBLIC_KEYS に存在する必要あり) */
  CHECKPOINT_SIGNING_KEY_ID?: string;
}

interface SessionRecord {
  firstSeenAt: string;
  lastCheckpointIndex: number;
  lastServerTimestamp: string;
  signedCount: number;
  /**
   * 直近に発行した envelope。冪等性のために保持する。
   *
   * 応答喪失 (network instability) からクライアントが同じ checkpointIndex で
   * 同内容の再要求を送ってきた場合、再署名せずこの envelope を返却する。
   * これがないと、サーバは KV 上で `lastCheckpointIndex` の単調性違反を理由に
   * 409 を返してしまい、その checkpoint は永久に失われる。
   */
  lastEnvelope?: SignedCheckpointEnvelope;
}

/** session record の TTL (秒). 検証可能性とは無関係 — 漏洩 sessionId による
 *  「古いセッション後付け改竄」攻撃の窓を短く保つ目的。 */
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** 1 セッションあたり許容する最大 checkpoint 数 (DoS 防御の最後の砦) */
const SESSION_MAX_CHECKPOINTS = 50_000;

interface CorsResponder {
  cors(extraHeaders?: Record<string, string>): HeadersInit;
}

interface ErrorBody {
  error: string;
  code:
    | 'SCHEMA_INVALID'
    | 'NON_MONOTONIC'
    | 'CHECKPOINT_CONFLICT'
    | 'SESSION_LIMIT_EXCEEDED'
    | 'SIGNING_KEY_NOT_CONFIGURED'
    | 'SIGNING_KEY_UNKNOWN'
    | 'SIGNING_ERROR';
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  });
}

let cachedPrivateKey: { keyId: string; key: CryptoKey } | null = null;

async function getSigningKey(env: CheckpointEnv): Promise<{ keyId: string; key: CryptoKey }> {
  if (!env.CHECKPOINT_SIGNING_KEY_JWK || !env.CHECKPOINT_SIGNING_KEY_ID) {
    throw Object.assign(new Error('Signing key not configured'), {
      code: 'SIGNING_KEY_NOT_CONFIGURED',
    });
  }
  if (cachedPrivateKey && cachedPrivateKey.keyId === env.CHECKPOINT_SIGNING_KEY_ID) {
    return cachedPrivateKey;
  }
  if (!findCheckpointPublicKey(env.CHECKPOINT_SIGNING_KEY_ID)) {
    throw Object.assign(new Error(`Signing keyId not in registry: ${env.CHECKPOINT_SIGNING_KEY_ID}`), {
      code: 'SIGNING_KEY_UNKNOWN',
    });
  }
  const jwk = JSON.parse(env.CHECKPOINT_SIGNING_KEY_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  cachedPrivateKey = { keyId: env.CHECKPOINT_SIGNING_KEY_ID, key };
  return cachedPrivateKey;
}

export async function handleSignCheckpoint(
  request: Request,
  env: CheckpointEnv,
  responder: CorsResponder
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(
      { error: 'Invalid JSON body', code: 'SCHEMA_INVALID' } satisfies ErrorBody,
      400,
      responder.cors()
    );
  }

  const validation = validateSignedCheckpointInput(parsed);
  if (!validation.ok) {
    return jsonResponse(
      { error: validation.reason, code: 'SCHEMA_INVALID' } satisfies ErrorBody,
      400,
      responder.cors()
    );
  }
  const input = validation.input;

  // 鍵を解決 (キャッシュあり)
  let signer: { keyId: string; key: CryptoKey };
  try {
    signer = await getSigningKey(env);
  } catch (err) {
    const code = (err as { code?: ErrorBody['code'] }).code ?? 'SIGNING_ERROR';
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err), code } satisfies ErrorBody,
      code === 'SIGNING_KEY_NOT_CONFIGURED' || code === 'SIGNING_KEY_UNKNOWN' ? 500 : 500,
      responder.cors()
    );
  }

  // KV からセッション状態を取得 (best-effort: eventual consistent)
  const sessionKey = `session:${input.sessionId}`;
  const existing = await env.CHECKPOINT_SESSIONS.get<SessionRecord>(sessionKey, 'json');

  const nowIso = new Date().toISOString();
  const firstSeenAt = existing?.firstSeenAt ?? nowIso;

  if (existing) {
    // 冪等性チェック: クライアントが「応答喪失からのリトライ」で同じ checkpointIndex
    // を再送してきた場合、内容一致なら新たに署名せず前回の envelope をそのまま返す。
    // これがないと NON_MONOTONIC 扱いでクライアントが詰む。
    if (
      input.checkpointIndex === existing.lastCheckpointIndex &&
      existing.lastEnvelope
    ) {
      if (isIdempotentSigningRetry(input, existing.lastEnvelope.payload)) {
        return jsonResponse({ envelope: existing.lastEnvelope }, 200, responder.cors());
      }
      // 同じ index で別内容 — 本物の衝突 (sessionId 重複生成 or 改竄)
      return jsonResponse(
        {
          error: `checkpointIndex ${input.checkpointIndex} already signed with different content`,
          code: 'CHECKPOINT_CONFLICT',
        } satisfies ErrorBody,
        409,
        responder.cors()
      );
    }
    if (input.checkpointIndex <= existing.lastCheckpointIndex) {
      return jsonResponse(
        {
          error: `checkpointIndex must be strictly greater than ${existing.lastCheckpointIndex}`,
          code: 'NON_MONOTONIC',
        } satisfies ErrorBody,
        409,
        responder.cors()
      );
    }
    if (existing.signedCount >= SESSION_MAX_CHECKPOINTS) {
      return jsonResponse(
        {
          error: `Session signedCount exceeds limit (${SESSION_MAX_CHECKPOINTS})`,
          code: 'SESSION_LIMIT_EXCEEDED',
        } satisfies ErrorBody,
        429,
        responder.cors()
      );
    }
  }

  // 署名
  let envelope;
  try {
    envelope = await createSignedCheckpointEnvelope(
      input,
      { serverTimestamp: nowIso, firstSeenAt },
      { keyId: signer.keyId, privateKey: signer.key }
    );
  } catch (err) {
    return jsonResponse(
      {
        error: err instanceof Error ? err.message : String(err),
        code: 'SIGNING_ERROR',
      } satisfies ErrorBody,
      500,
      responder.cors()
    );
  }

  // KV 更新 (best-effort)
  const nextRecord: SessionRecord = {
    firstSeenAt,
    lastCheckpointIndex: input.checkpointIndex,
    lastServerTimestamp: nowIso,
    signedCount: (existing?.signedCount ?? 0) + 1,
    lastEnvelope: envelope,
  };
  try {
    await env.CHECKPOINT_SESSIONS.put(sessionKey, JSON.stringify(nextRecord), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
  } catch {
    // KV 書き込み失敗は致命的ではない (次回書き込みで状態追従)。
    // 署名は既に出ているのでクライアントに返す。
  }

  return jsonResponse({ envelope }, 200, responder.cors());
}

export function handlePublicKeys(responder: CorsResponder): Response {
  // 公開鍵 registry はビルド時に git から固定 (削除しないので長期検証可能)。
  const keys = CHECKPOINT_PUBLIC_KEYS.map(({ description, ...rest }) => rest);
  return jsonResponse(
    { keys, cacheTtlSec: 86400 },
    200,
    responder.cors({ 'Cache-Control': 'public, max-age=3600' })
  );
}
