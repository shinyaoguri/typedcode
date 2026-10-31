/**
 * 予期しない例外がサーバログに残ること (#285 w3)。
 *
 * verify-captcha / verify-attestation の catch は 500 を返すだけで原因を握りつぶしていた。
 * 応答の形 (500 + 固定文言) は変えず、原因を console.error に出す。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function post(path: string, body: unknown): Request {
  return new Request(`https://workers.test${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
  });
}

describe('unexpected-error logging', () => {
  it('logs the cause and keeps the 500 shape when verify-captcha fails unexpectedly', async () => {
    // siteverify が 200 + HTML を返す (JSON として読めない) と response.json() が throw する。
    globalThis.fetch = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      TURNSTILE_SECRET_KEY: 's',
      ATTESTATION_SECRET_KEY: 'a',
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'https://typedcode.dev',
    } as unknown as TestEnv;

    const res = await worker.fetch(post('/api/verify-captcha', { token: 'tt' }), env);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, score: 0, message: 'Internal server error' });
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('[verify-captcha]'))).toBe(true);
  });

  it('logs the cause and keeps the 500 shape when verify-attestation fails unexpectedly', async () => {
    // ATTESTATION_SECRET_KEY が空だと HMAC の importKey (長さ 0 の raw 鍵) が throw する。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      TURNSTILE_SECRET_KEY: 's',
      ATTESTATION_SECRET_KEY: '',
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'https://typedcode.dev',
    } as unknown as TestEnv;
    const attestation = { verified: true, score: 1, action: 'a', timestamp: 't', hostname: 'h', signature: 'sig' };

    const res = await worker.fetch(post('/api/verify-attestation', { attestation }), env);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ valid: false, message: 'Internal server error' });
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('[verify-attestation]'))).toBe(true);
  });
});
