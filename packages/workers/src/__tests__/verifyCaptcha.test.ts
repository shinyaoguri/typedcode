/**
 * `/api/verify-captcha` は署名用の secret 無しで動き、attestation を署名しない (#415)。
 *
 * 以前は `ATTESTATION_SECRET_KEY` で HMAC 署名した attestation を返していたが、署名を検証する場所が
 * どこにも無かったのでやめた。成功時は Turnstile の結果を `signature: 'unsigned'` の attestation として
 * 返し続ける (旧 editor は attestation の無い成功応答を失敗扱いにするため)。失敗時の応答は変えない。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** `ATTESTATION_SECRET_KEY` を持たない env (staging / production の新しい `[secrets] required` と同じ) */
const env = {
  TURNSTILE_SECRET_KEY: 'secret',
  ENVIRONMENT: 'production',
  ALLOWED_ORIGINS: 'https://typedcode.dev',
} as unknown as TestEnv;

function stubSiteverify(body: Record<string, unknown>): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function post(body: unknown): Request {
  return new Request('https://workers.test/api/verify-captcha', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
  });
}

describe('/api/verify-captcha without an attestation secret', () => {
  it('returns an unsigned attestation carrying the Turnstile result when verification succeeds', async () => {
    stubSiteverify({
      success: true,
      hostname: 'typedcode.dev',
      action: 'export_proof',
      challenge_ts: '2026-11-04T00:00:00Z',
    });

    const res = await worker.fetch(post({ token: 'tt' }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      score: 1,
      message: 'Verified',
      attestation: {
        verified: true,
        score: 1,
        action: 'export_proof',
        timestamp: '2026-11-04T00:00:00Z',
        hostname: 'typedcode.dev',
        signature: 'unsigned',
      },
    });
  });

  it('answers 403 without an attestation when Turnstile rejects the token', async () => {
    stubSiteverify({ success: false, hostname: '', challenge_ts: '', 'error-codes': ['invalid-input-response'] });

    const res = await worker.fetch(post({ token: 'tt' }), env);

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body).not.toHaveProperty('attestation');
  });

  it('answers 403 without an attestation when the token was solved on a disallowed hostname', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSiteverify({
      success: true,
      hostname: 'evil.example',
      action: 'export_proof',
      challenge_ts: '2026-11-04T00:00:00Z',
    });

    const res = await worker.fetch(post({ token: 'tt' }), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      score: 0,
      message: 'Verification failed: hostname not allowed',
    });
  });
});

describe('/api/verify-captcha with a Turnstile testing-key result (#660)', () => {
  /** Cloudflare の公開テストキーの secret で siteverify したときの結果 (#660 の実測と同じ形) */
  const testingKeyResult = {
    success: true,
    hostname: 'example.com',
    challenge_ts: '2026-11-07T00:00:00Z',
    'error-codes': [],
    metadata: { result_with_testing_key: true },
  };

  /** staging Worker と同じ ALLOWED_ORIGINS (wrangler.staging.toml) */
  const STAGING_ALLOWED_ORIGINS = 'https://*.typedcode.pages.dev';
  /** production Worker と同じ ALLOWED_ORIGINS (wrangler.production.toml) */
  const PRODUCTION_ALLOWED_ORIGINS = 'https://typedcode.dev,https://typedcode.pages.dev';

  function envFor(environment: string | undefined, allowedOrigins: string | undefined): TestEnv {
    return {
      TURNSTILE_SECRET_KEY: 'secret',
      ENVIRONMENT: environment,
      ALLOWED_ORIGINS: allowedOrigins,
    } as unknown as TestEnv;
  }

  it('answers verified on staging even though the testing key reports hostname example.com', async () => {
    stubSiteverify(testingKeyResult);

    const res = await worker.fetch(post({ token: 'tt' }), envFor('staging', STAGING_ALLOWED_ORIGINS));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; attestation?: { verified: boolean } };
    expect(body.success).toBe(true);
    expect(body.attestation?.verified).toBe(true);
  });

  // ALLOWED_ORIGINS が無い行は hostname 照合が飛ぶので、testing key の拒否だけが 403 の理由になる。
  it.each([
    ['production', 'production', PRODUCTION_ALLOWED_ORIGINS],
    ['unset', undefined, undefined],
    ['an unknown value', 'preview', undefined],
  ])(
    'answers 403 like a disallowed hostname when ENVIRONMENT is %s (fail-closed)',
    async (_label, environment, allowedOrigins) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubSiteverify(testingKeyResult);

      const res = await worker.fetch(post({ token: 'tt' }), envFor(environment, allowedOrigins));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        success: false,
        score: 0,
        message: 'Verification failed: hostname not allowed',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('testing key'), 'example.com');
    }
  );

  it('still answers 403 for a non-testing-key result solved on a disallowed hostname on staging', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSiteverify({ success: true, hostname: 'example.com', challenge_ts: '2026-11-07T00:00:00Z' });

    const res = await worker.fetch(post({ token: 'tt' }), envFor('staging', STAGING_ALLOWED_ORIGINS));

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Verification failed: hostname not allowed');
  });
});
