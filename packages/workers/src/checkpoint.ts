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
  verifySessionStartToken,
} from '@typedcode/shared/checkpoint';
import type {
  CheckpointPublicKey,
  SessionStartToken,
  SignedCheckpointEnvelope,
} from '@typedcode/shared/checkpoint';

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

/**
 * 1 セッションあたり許容する最大タブ数 (ADR-0027)。
 * sessionStartToken 前提化で sessionId は Turnstile 1 回に束縛されるが、tabId は
 * クライアント任意文字列のまま (class の N 問タブは token 発行時点で数が確定しない)。
 * tabId 連打による KV キー増幅を「1 Turnstile → 最大 N キー」に抑える蓋。
 * class バンドルの現実的な問題数 (≤30 程度) に大きく余裕を持たせた値。
 */
const MAX_TABS_PER_SESSION = 64;

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
    | 'TOKEN_REQUIRED'
    | 'TOKEN_INVALID'
    | 'TOKEN_SESSION_MISMATCH'
    | 'NON_MONOTONIC'
    | 'CHECKPOINT_CONFLICT'
    | 'SESSION_LIMIT_EXCEEDED'
    | 'TAB_LIMIT_EXCEEDED'
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

/**
 * リクエスト body から sessionStartToken を取り出す (形だけの緩い検査)。
 * 署名・registry・payload の実検証は shared の verifySessionStartToken が行う。
 */
function extractSessionStartToken(parsed: unknown): SessionStartToken | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as Record<string, unknown>).sessionStartToken;
  if (!raw || typeof raw !== 'object') return null;
  const token = raw as Record<string, unknown>;
  if (!token.payload || typeof token.payload !== 'object') return null;
  if (typeof token.signature !== 'string' || typeof token.keyId !== 'string') return null;
  return raw as SessionStartToken;
}

export async function handleSignCheckpoint(
  request: Request,
  env: CheckpointEnv,
  responder: CorsResponder,
  /** テスト用: token 検証に使う公開鍵 registry の差し替え (既定は本番 registry)。 */
  tokenKeyRegistry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
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

  // ADR-0027 (#136): 署名は sessionStartToken 前提。sessionId はクライアント任意文字列
  // なので、新規 sessionId 連打で per-session 上限を回避する KV write 増幅 DoS に開いていた。
  // token は ECDSA でステートレス検証でき、sessionId を「Turnstile 1 回」に束縛する
  // (KV read より前に検証し、無認証リクエストには KV コストを一切払わない)。
  const sessionStartToken = extractSessionStartToken(parsed);
  if (!sessionStartToken) {
    return jsonResponse(
      {
        error: 'sessionStartToken is required to sign checkpoints (ADR-0027)',
        code: 'TOKEN_REQUIRED',
      } satisfies ErrorBody,
      401,
      responder.cors()
    );
  }
  let tokenResult: Awaited<ReturnType<typeof verifySessionStartToken>>;
  try {
    tokenResult = await verifySessionStartToken(sessionStartToken, tokenKeyRegistry);
  } catch (err) {
    console.error('[checkpoint] session token verification threw:', err);
    tokenResult = { valid: false, reason: 'Malformed session token' };
  }
  if (!tokenResult.valid) {
    // 検証失敗の内部理由 (registry の keyId 等) は返さず固定文言。詳細はサーバログのみ。
    console.warn('[checkpoint] session token rejected:', tokenResult.reason);
    return jsonResponse(
      { error: 'Session start token is invalid', code: 'TOKEN_INVALID' } satisfies ErrorBody,
      401,
      responder.cors()
    );
  }
  if (sessionStartToken.payload.sessionId !== input.sessionId) {
    return jsonResponse(
      {
        error: 'Session start token does not match the request sessionId',
        code: 'TOKEN_SESSION_MISMATCH',
      } satisfies ErrorBody,
      401,
      responder.cors()
    );
  }

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

  // ADR-0027: tabId 増幅の蓋。token で sessionId は Turnstile 1 回に束縛されるが、
  // tabId は任意文字列のまま (class の N 問タブは token 発行時点で数が不定なため
  // token に焼けない)。新規タブの初回署名時のみ per-session のタブ台帳を見て上限を
  // 強制し、「1 Turnstile → 無制限の KV キー」を塞ぐ。KV は結果整合なので同時開始
  // タブで多少の over-admission はありうる (厳密化は DO 化 = ADR-0027 の再評価条件)。
  const tabsKey = `session:${input.sessionId}:tabs`;
  let knownTabs: string[] | null = null;
  if (isFirstCheckpoint) {
    try {
      knownTabs = (await env.CHECKPOINT_SESSIONS.get<string[]>(tabsKey, 'json')) ?? [];
    } catch (err) {
      // タブ台帳は best-effort の防御線: 読めないときは cap 判定をスキップして署名は通す
      // (KV 障害で正規ユーザーを締め出さない。session record 側の read 失敗は上で 503 済み)。
      console.error('[checkpoint] tab registry read failed:', err);
      knownTabs = null;
    }
    if (
      knownTabs &&
      !knownTabs.includes(input.tabId) &&
      knownTabs.length >= MAX_TABS_PER_SESSION
    ) {
      return jsonResponse(
        {
          error: `Session tab count exceeds limit (${MAX_TABS_PER_SESSION})`,
          code: 'TAB_LIMIT_EXCEEDED',
        } satisfies ErrorBody,
        429,
        responder.cors()
      );
    }
  }

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

  // タブ台帳への登録 (best-effort)。書けなくても署名は成立させる — 台帳は cap 判定の
  // ための防御線であり、欠けても under-count (= cap が甘くなる) 側にしか倒れない。
  if (isFirstCheckpoint && knownTabs && !knownTabs.includes(input.tabId)) {
    try {
      await env.CHECKPOINT_SESSIONS.put(tabsKey, JSON.stringify([...knownTabs, input.tabId]), {
        expirationTtl: SESSION_TTL_SECONDS,
      });
    } catch (err) {
      console.error('[checkpoint] tab registry write failed:', err);
    }
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
