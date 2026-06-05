/**
 * TypedCode API - Cloudflare Workers
 * Turnstile 検証エンドポイント with 署名付き証明書
 */

import {
  handleSignCheckpoint,
  handlePublicKeys,
  type CheckpointEnv,
} from './checkpoint.js';

interface Env extends CheckpointEnv {
  TURNSTILE_SECRET_KEY: string;
  ATTESTATION_SECRET_KEY: string; // 証明書署名用の秘密鍵
  ENVIRONMENT: string;
  /**
   * CORS 許可オリジン (カンマ区切り)。例: "https://app.example.com,https://verify.example.com"。
   * production / staging では設定必須 (未設定だと後方互換で任意 Origin を reflect する)。
   */
  ALLOWED_ORIGINS?: string;
}

/** CORS の許可判定に必要な env の最小サブセット */
type CorsEnv = Pick<Env, 'ALLOWED_ORIGINS' | 'ENVIRONMENT'>;

interface TurnstileResponse {
  success: boolean;
  challenge_ts: string;
  hostname: string;
  'error-codes'?: string[];
  action?: string;
  cdata?: string;
}

/**
 * 署名付き証明書（改竄防止）
 */
interface HumanAttestation {
  verified: boolean;
  score: number;
  action: string;
  timestamp: string;
  hostname: string;
  signature: string; // HMAC-SHA256署名
}

interface VerifyResponse {
  success: boolean;
  score: number;
  message: string;
  attestation?: HumanAttestation; // 検証成功時のみ
}

/** ALLOWED_ORIGINS (カンマ区切り) を正規化した配列にする */
function parseAllowedOrigins(env: CorsEnv): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0);
}

function isLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Origin を許可パターンと照合する。完全一致のほか、`https://*.example.com`
 * 形式のサブドメイン wildcard に対応する。
 *
 * wildcard は **1 段以上のサブドメインを要求** する (apex は含めない)。先頭の
 * リテラルドット (`.example.com`) を要求することで `https://evilexample.com`
 * のような prefix 偽装を弾く。`*.<project>.pages.dev` のように自プロジェクト配下に
 * 限定して使う前提で、`*.pages.dev` のような広すぎるパターンは設定しないこと。
 */
function originMatchesPattern(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  const marker = '://*.';
  const idx = pattern.indexOf(marker);
  if (idx === -1) return false;
  const scheme = pattern.slice(0, idx); // 例: "https"
  const baseDomain = pattern.slice(idx + marker.length); // 例: "typedcode.pages.dev"
  const prefix = `${scheme}://`;
  if (!origin.startsWith(prefix)) return false;
  const host = origin.slice(prefix.length); // origin は scheme://host[:port] でパスは持たない
  return host.length > baseDomain.length + 1 && host.endsWith(`.${baseDomain}`);
}

/**
 * リクエスト Origin を許可リストに照合し、許可するときのみその Origin を返す。
 * 返り値を `Access-Control-Allow-Origin` にそのまま入れる (reflect)。許可しないときは null。
 *
 * 優先順位 (**fail-closed**):
 *  1. `ALLOWED_ORIGINS` に一致 (完全一致 or `*.domain` サブドメイン wildcard) → 許可
 *  2. `ENVIRONMENT === 'development'` のとき localhost / 127.0.0.1 → 許可 (開発体験)
 *  3. それ以外 → 拒否 (ヘッダを付与しない)
 *
 * 旧実装は `ALLOWED_ORIGINS` 未設定時に任意 Origin を reflect する fail-open
 * だったが、staging/production の wrangler config に値を commit したため廃止。
 * 非 development で許可リストが空 / 不一致なら拒否する (新環境では設定必須)。
 *
 * なお CORS はブラウザのクロスオリジン**読み取り**のみを制限するもので、
 * サーバ間アクセス (curl 等) は防げない。署名 API の濫用は per-session 上限
 * (`SESSION_MAX_CHECKPOINTS`) と Cloudflare 側の rate limit で防ぐ。
 */
function resolveCorsOrigin(origin: string | null, env: CorsEnv): string | null {
  if (!origin) return null;
  const allowed = parseAllowedOrigins(env);
  if (allowed.some(pattern => originMatchesPattern(origin, pattern))) return origin;
  if (env.ENVIRONMENT === 'development' && isLocalhostOrigin(origin)) return origin;
  return null; // fail-closed: 許可リストに無い (or 未設定の) Origin は拒否
}

/**
 * CORSヘッダーを返す。許可されない Origin には `Access-Control-Allow-Origin` を付けない。
 */
function corsHeaders(origin: string | null, env: CorsEnv): HeadersInit {
  const allowOrigin = resolveCorsOrigin(origin, env);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
  }
  return headers;
}

/**
 * CORS preflight リクエストを処理
 */
function handleCORS(request: Request, env: CorsEnv): Response {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, env),
  });
}

/** /api/checkpoint/* で使う CORS レスポンダ */
function checkpointResponder(origin: string | null, env: CorsEnv): { cors(extra?: Record<string, string>): HeadersInit } {
  return {
    cors(extra: Record<string, string> = {}) {
      return { ...corsHeaders(origin, env), ...extra };
    },
  };
}

/**
 * HMAC-SHA256署名を生成
 */
async function createHmacSignature(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 文字列の定数時間比較。HMAC 署名のような秘密値の比較に使う。
 *
 * 通常の `===` は最初に異なる文字で early-return するため、比較にかかる時間から
 * 「正解 prefix の長さ」が漏れ得る (timing attack)。ここでは長さが一致する限り
 * 全文字を XOR で畳み込み、early-return しないことで内容に依存しない時間にする。
 * (期待値 = HMAC-SHA256 hex は常に固定長 128 文字なので、長さの早期判定は秘密を漏らさない)
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Turnstile検証を実行
 */
async function verifyTurnstile(
  token: string,
  secretKey: string
): Promise<TurnstileResponse> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      secret: secretKey,
      response: token,
    }),
  });

  return response.json();
}

/**
 * 署名付き証明書を生成
 */
async function createAttestation(
  result: TurnstileResponse,
  attestationSecret: string
): Promise<HumanAttestation> {
  const attestationData = {
    verified: result.success,
    score: 1.0, // Turnstile has no score, always 1.0 on success
    action: result.action ?? 'unknown',
    timestamp: result.challenge_ts,
    hostname: result.hostname,
  };

  // 署名対象データ（JSON文字列化して署名）
  const dataToSign = JSON.stringify(attestationData);
  const signature = await createHmacSignature(dataToSign, attestationSecret);

  return {
    ...attestationData,
    signature,
  };
}

/**
 * Turnstile検証エンドポイント
 */
async function handleVerifyCaptcha(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = request.headers.get('Origin');

  try {
    const body = await request.json<{ token: string }>();
    const { token } = body;

    if (!token) {
      return new Response(
        JSON.stringify({
          success: false,
          score: 0,
          message: 'Token is required',
        } satisfies VerifyResponse),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin, env),
          },
        }
      );
    }

    const result = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY);
    const isVerified = result.success;

    // 署名付き証明書を生成（検証成功時のみ）
    let attestation: HumanAttestation | undefined;
    if (isVerified && env.ATTESTATION_SECRET_KEY) {
      attestation = await createAttestation(result, env.ATTESTATION_SECRET_KEY);
    }

    const response: VerifyResponse = {
      success: isVerified,
      score: isVerified ? 1.0 : 0,
      message: result.success
        ? 'Verified'
        : `Verification failed: ${result['error-codes']?.join(', ') ?? 'Unknown error'}`,
      attestation,
    };

    return new Response(JSON.stringify(response), {
      status: response.success ? 200 : 403,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin, env),
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        score: 0,
        message: 'Internal server error',
      } satisfies VerifyResponse),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin, env),
        },
      }
    );
  }
}

/**
 * 証明書に含まれる可能性のある追加フィールド（署名対象外）
 */
interface AttestationWithExtras extends HumanAttestation {
  success?: boolean;
  failureReason?: string;
}

/**
 * 証明書検証エンドポイント（検証ページから呼び出される）
 */
async function handleVerifyAttestation(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = request.headers.get('Origin');

  try {
    const body = await request.json<{ attestation: AttestationWithExtras }>();
    const { attestation } = body;

    if (!attestation) {
      return new Response(
        JSON.stringify({ valid: false, message: 'Attestation is required' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin, env),
          },
        }
      );
    }

    // 署名対象フィールドのみを抽出（success, failureReason, signatureは除外）
    const { signature, success: _success, failureReason: _failureReason, ...coreData } = attestation;
    const attestationData = {
      verified: coreData.verified,
      score: coreData.score,
      action: coreData.action,
      timestamp: coreData.timestamp,
      hostname: coreData.hostname,
    };
    const dataToSign = JSON.stringify(attestationData);
    const expectedSignature = await createHmacSignature(dataToSign, env.ATTESTATION_SECRET_KEY);

    const isValid =
      typeof signature === 'string' && timingSafeEqual(signature, expectedSignature);

    return new Response(
      JSON.stringify({
        valid: isValid,
        message: isValid ? 'Attestation is valid' : 'Invalid signature',
        attestation: isValid ? attestationData : undefined,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin, env),
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ valid: false, message: 'Internal server error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(origin, env),
        },
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // ルーティング
    if (url.pathname === '/api/verify-captcha' && request.method === 'POST') {
      return handleVerifyCaptcha(request, env);
    }

    // 証明書検証エンドポイント
    if (url.pathname === '/api/verify-attestation' && request.method === 'POST') {
      return handleVerifyAttestation(request, env);
    }

    // Signed checkpoint endpoints
    if (url.pathname === '/api/checkpoint/sign' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      return handleSignCheckpoint(request, env, checkpointResponder(origin, env));
    }
    if (url.pathname === '/api/checkpoint/public-keys' && request.method === 'GET') {
      const origin = request.headers.get('Origin');
      return handlePublicKeys(checkpointResponder(origin, env));
    }

    // ヘルスチェック
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', environment: env.ENVIRONMENT }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
