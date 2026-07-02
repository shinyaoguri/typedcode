/**
 * /api/checkpoint/sign + /api/checkpoint/public-keys ハンドラ。
 *
 * 設計:
 * - サーバは最小限の KV 状態 (session:{sessionId}:{tabId}) のみ保持する (タブ毎)。
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

/** 署名リクエスト body の最大サイズ (bytes)。固定スキーマの cp 1 件は ~1KB 程度。
 *  署名 API なので余裕を見つつ上限を設けて巨大 body をパース前に弾く。 */
const MAX_BODY_BYTES = 8 * 1024;

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
    | 'SIGNING_ERROR'
    | 'SESSION_PERSIST_FAILED'
    | 'SESSION_STATE_UNAVAILABLE';
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

/**
 * checkpoint 署名鍵 (ECDSA-P256 private) をロードする。キャッシュあり。
 * ADR-0017 の session/start トークン署名もこの鍵を流用する (運用一系統)。
 */
export async function getSigningKey(env: CheckpointEnv): Promise<{ keyId: string; key: CryptoKey }> {
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
  // body サイズ上限: まず Content-Length があればパース前に弾く (巨大 body の DoS 対策)。
  const contentLength = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse(
      { error: `Request body exceeds ${MAX_BODY_BYTES} bytes`, code: 'SCHEMA_INVALID' } satisfies ErrorBody,
      400,
      responder.cors()
    );
  }

  // 本文を読み、Content-Length が欠落/詐称/chunked でも **実バイト長** で上限を強制する。
  // (Number('') === 0 や NaN で上の事前チェックを擦り抜けるケースの保険。)
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse(
      { error: 'Invalid request body', code: 'SCHEMA_INVALID' } satisfies ErrorBody,
      400,
      responder.cors()
    );
  }
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return jsonResponse(
      { error: `Request body exceeds ${MAX_BODY_BYTES} bytes`, code: 'SCHEMA_INVALID' } satisfies ErrorBody,
      400,
      responder.cors()
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
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
    // 内部例外メッセージ (keyId / JWK パーサのテキスト等) はクライアントに返さず、
    // 固定文言を返す。詳細はサーバログにのみ出す。
    console.error('[checkpoint] signing key resolution failed:', err);
    return jsonResponse(
      { error: 'Signing key is not available', code } satisfies ErrorBody,
      500,
      responder.cors()
    );
  }

  // KV からセッション状態を取得 (best-effort: eventual consistent)。
  // **tabId 込みでキーイングする**: checkpointIndex はタブ毎に 0 から振られ、sessionId は
  // ブラウザセッション全体で共有される。sessionId だけでキーイングすると、複数タブ
  // (class モードの N 問タブ等) で 2 枚目以降のタブが checkpointIndex 衝突 → CHECKPOINT_CONFLICT /
  // NON_MONOTONIC となり 1 つも署名されない。verifier は firstSeenAt をタブ間で共有要求しない
  // (proof = 1 タブ) ので、firstSeenAt がタブ毎に確定するのは安全。
  const sessionKey = `session:${input.sessionId}:${input.tabId}`;
  // KV read の失敗は「existing = null」と混同してはいけない (#153/#151): null 扱いにすると
  // 既存セッションに新しい firstSeenAt で署名してしまい、verifier の firstSeenAt 完全一致
  // 要求により proof 全体が検証不能になる。必ず 503 でクライアントにリトライさせる。
  let existing: SessionRecord | null;
  try {
    existing = await env.CHECKPOINT_SESSIONS.get<SessionRecord>(sessionKey, 'json');
  } catch (err) {
    console.error('[checkpoint] KV read failed:', err);
    return jsonResponse(
      {
        error: 'Failed to read session state; retry the signing request',
        code: 'SESSION_STATE_UNAVAILABLE',
      } satisfies ErrorBody,
      503,
      responder.cors()
    );
  }

  // このセッションで初めて署名する checkpoint か。初回は firstSeenAt が
  // まだ KV に固定されていないため、KV 永続化を「成功条件」として扱う必要がある。
  const isFirstCheckpoint = !existing;

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
    // 内部例外メッセージはクライアントに返さず固定文言にする。詳細はサーバログのみ。
    console.error('[checkpoint] signing failed:', err);
    return jsonResponse(
      { error: 'Failed to sign checkpoint', code: 'SIGNING_ERROR' } satisfies ErrorBody,
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
    if (isFirstCheckpoint) {
      // 初回書き込みの失敗は致命的: firstSeenAt がまだ KV 上に固定されていない。
      // ここで envelope を返してしまうと、次回リクエスト時に existing が依然 null と
      // なり、別の firstSeenAt が確定する。verifier はすべての envelope で firstSeenAt
      // の一致を要求するため、これは proof 全体の検証失敗につながる。
      // よって署名済み envelope は破棄し、クライアントにリトライさせる。
      return jsonResponse(
        {
          error: 'Failed to persist initial session state; retry the signing request',
          code: 'SESSION_PERSIST_FAILED',
        } satisfies ErrorBody,
        503,
        responder.cors()
      );
    }
    // 2 回目以降は firstSeenAt が既に KV 上で確定済みなので best-effort で良い
    // (失敗しても次回の書き込みで lastCheckpointIndex / lastEnvelope が追従する)。
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
