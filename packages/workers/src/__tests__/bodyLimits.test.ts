/**
 * POST ハンドラの本文上限と入力検査 (#285)。
 *
 * 不正な本文 (巨大 / 不正 JSON / 不正な token) は Turnstile の fetch・署名・KV に触れる前に
 * 400 で弾く。外部呼び出しが 0 回であることを globalThis.fetch のスパイで確かめる。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index.js';
import { MAX_JSON_BODY_BYTES, MAX_TURNSTILE_TOKEN_LENGTH } from '../body.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ success: true, hostname: 'typedcode.dev', action: 'x', challenge_ts: '2026-06-12T00:00:00Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = {
  TURNSTILE_SECRET_KEY: 'secret',
  ATTESTATION_SECRET_KEY: 'attest',
  ENVIRONMENT: 'production',
  ALLOWED_ORIGINS: 'https://typedcode.dev',
} as unknown as TestEnv;

const ENDPOINTS = ['/api/verify-captcha', '/api/verify-attestation', '/api/session/start'] as const;

/** Content-Length 無しのストリーム本文 (chunked 相当) */
function streamPost(path: string, chunks: Uint8Array[]): Request {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return new Request(`https://workers.test${path}`, {
    method: 'POST',
    body: stream,
    headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function jsonPost(path: string, body: unknown): Request {
  return new Request(`https://workers.test${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
  });
}

describe('POST body limits (verify-captcha / verify-attestation / session/start)', () => {
  it.each(ENDPOINTS)('%s rejects a body over the limit with 400 before any outbound call', async (path) => {
    const filler = new TextEncoder().encode('x'.repeat(1024));
    const chunks = Array.from({ length: MAX_JSON_BODY_BYTES / 1024 + 1 }, () => filler); // 8KiB + 1KiB
    const res = await worker.fetch(streamPost(path, chunks), env);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(ENDPOINTS)('%s rejects malformed JSON with 400 before any outbound call', async (path) => {
    const res = await worker.fetch(jsonPost(path, '{ "broken'), env);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(ENDPOINTS)('%s answers a rejected body in its own JSON shape', async (path) => {
    const res = await worker.fetch(jsonPost(path, '{ "broken'), env);
    const body = (await res.json()) as Record<string, unknown>;
    if (path === '/api/verify-attestation') {
      expect(body.valid).toBe(false);
    } else {
      expect(body.success).toBe(false);
    }
    expect(typeof body.message).toBe('string');
  });
});

describe('Turnstile token validation', () => {
  const SESSION_FIELDS = { sessionId: 'session-A', fingerprintHash: 'f'.repeat(64) };

  const CASES = [
    {
      path: '/api/verify-captcha',
      body: (token: unknown) => ({ token }),
    },
    {
      path: '/api/session/start',
      body: (token: unknown) => ({ turnstileToken: token, ...SESSION_FIELDS }),
    },
  ] as const;

  describe.each(CASES)('$path', ({ path, body }) => {
    it(`rejects a token longer than ${MAX_TURNSTILE_TOKEN_LENGTH} characters without calling Turnstile`, async () => {
      const res = await worker.fetch(jsonPost(path, body('t'.repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1))), env);
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`passes a token of exactly ${MAX_TURNSTILE_TOKEN_LENGTH} characters on to Turnstile`, async () => {
      const res = await worker.fetch(jsonPost(path, body('t'.repeat(MAX_TURNSTILE_TOKEN_LENGTH))), env);
      // session/start はこの env に署名鍵が無く後段で 500 になるので、ステータスではなく
      // 「入力検査を通って Turnstile まで進んだ」ことを見る。
      expect(res.status).not.toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an object', {}],
      ['a number', 123],
      ['an empty string', ''],
      ['null', null],
    ])('rejects a token that is %s without calling Turnstile', async (_name, token) => {
      const res = await worker.fetch(jsonPost(path, body(token)), env);
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
