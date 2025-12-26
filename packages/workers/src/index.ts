/**
 * TypedCode API - Cloudflare Workers
 * reCAPTCHA v3 検証エンドポイント with 署名付き証明書
 */

interface Env {
  RECAPTCHA_SECRET_KEY: string;
  ATTESTATION_SECRET_KEY: string; // 証明書署名用の秘密鍵
  ENVIRONMENT: string;
}

interface RecaptchaResponse {
  success: boolean;
  score: number;
  action: string;
  challenge_ts: string;
  hostname: string;
  'error-codes'?: string[];
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

/**
 * CORSヘッダーを返す
 */
function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * CORS preflight リクエストを処理
 */
function handleCORS(request: Request): Response {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
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
 * reCAPTCHA検証を実行
 */
async function verifyCaptcha(
  token: string,
  secretKey: string
): Promise<RecaptchaResponse> {
  const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
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
  result: RecaptchaResponse,
  attestationSecret: string
): Promise<HumanAttestation> {
  const attestationData = {
    verified: result.success && result.score >= 0.5,
    score: result.score,
    action: result.action,
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
 * reCAPTCHA検証エンドポイント
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
            ...corsHeaders(origin),
          },
        }
      );
    }

    const result = await verifyCaptcha(token, env.RECAPTCHA_SECRET_KEY);
    const isVerified = result.success && result.score >= 0.5;

    // 署名付き証明書を生成（検証成功時のみ）
    let attestation: HumanAttestation | undefined;
    if (isVerified && env.ATTESTATION_SECRET_KEY) {
      attestation = await createAttestation(result, env.ATTESTATION_SECRET_KEY);
    }

    const response: VerifyResponse = {
      success: isVerified,
      score: result.score ?? 0,
      message: result.success
        ? result.score >= 0.5
          ? 'Verified'
          : 'Score too low'
        : `Verification failed: ${result['error-codes']?.join(', ') ?? 'Unknown error'}`,
      attestation,
    };

    return new Response(JSON.stringify(response), {
      status: response.success ? 200 : 403,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin),
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
          ...corsHeaders(origin),
        },
      }
    );
  }
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
    const body = await request.json<{ attestation: HumanAttestation }>();
    const { attestation } = body;

    if (!attestation) {
      return new Response(
        JSON.stringify({ valid: false, message: 'Attestation is required' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin),
          },
        }
      );
    }

    // 署名を除いたデータで再計算
    const { signature, ...attestationData } = attestation;
    const dataToSign = JSON.stringify(attestationData);
    const expectedSignature = await createHmacSignature(dataToSign, env.ATTESTATION_SECRET_KEY);

    const isValid = signature === expectedSignature;

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
          ...corsHeaders(origin),
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
          ...corsHeaders(origin),
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
      return handleCORS(request);
    }

    // ルーティング
    if (url.pathname === '/api/verify-captcha' && request.method === 'POST') {
      return handleVerifyCaptcha(request, env);
    }

    // 証明書検証エンドポイント
    if (url.pathname === '/api/verify-attestation' && request.method === 'POST') {
      return handleVerifyAttestation(request, env);
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
