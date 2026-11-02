/**
 * CORS 許可オリジンの挙動テスト。
 *
 * preflight (OPTIONS) はシークレットに触れず handleCORS だけを通るので、
 * fetch ハンドラ経由で `Access-Control-Allow-Origin` の reflect/拒否を検証する。
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

function baseEnv(overrides: Partial<Record<string, string>> = {}): TestEnv {
  return {
    TURNSTILE_SECRET_KEY: 'x',
    ATTESTATION_SECRET_KEY: 'x',
    ENVIRONMENT: 'production',
    ...overrides,
  } as unknown as TestEnv;
}

function preflight(origin: string | null): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers['Origin'] = origin;
  return new Request('https://api.test/api/checkpoint/sign', { method: 'OPTIONS', headers });
}

describe('CORS allowed-origin policy', () => {
  it('reflects an origin that is in ALLOWED_ORIGINS', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: 'https://app.example.com,https://verify.example.com' });
    const res = await worker.fetch(preflight('https://verify.example.com'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://verify.example.com');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('does NOT set Access-Control-Allow-Origin for a disallowed origin when configured', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: 'https://app.example.com' });
    const res = await worker.fetch(preflight('https://evil.example.com'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows localhost in development regardless of ALLOWED_ORIGINS', async () => {
    const env = baseEnv({ ENVIRONMENT: 'development', ALLOWED_ORIGINS: 'https://app.example.com' });
    const res = await worker.fetch(preflight('http://localhost:5173'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('rejects localhost in production when not in ALLOWED_ORIGINS', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: 'https://app.example.com' });
    const res = await worker.fetch(preflight('http://localhost:5173'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('fail-closed: rejects any origin when ALLOWED_ORIGINS is unset in a non-dev environment', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: undefined });
    const res = await worker.fetch(preflight('https://anything.example.com'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('development still allows localhost even when ALLOWED_ORIGINS is unset', async () => {
    const env = baseEnv({ ENVIRONMENT: 'development', ALLOWED_ORIGINS: undefined });
    const res = await worker.fetch(preflight('http://localhost:5173'), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('never emits a wildcard "*" Access-Control-Allow-Origin', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: undefined });
    const res = await worker.fetch(preflight(null), env);
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });

  // ---- production の実設定 ----
  describe('with production ALLOWED_ORIGINS', () => {
    const prod = () => baseEnv({ ALLOWED_ORIGINS: 'https://typedcode.dev,https://typedcode.pages.dev' });

    it('allows the custom domain', async () => {
      const res = await worker.fetch(preflight('https://typedcode.dev'), prod());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://typedcode.dev');
    });

    it('allows the default pages.dev domain', async () => {
      const res = await worker.fetch(preflight('https://typedcode.pages.dev'), prod());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://typedcode.pages.dev');
    });

    it('rejects a preview subdomain (those use staging, not production)', async () => {
      const res = await worker.fetch(preflight('https://abc123.typedcode.pages.dev'), prod());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  // ---- staging のサブドメイン wildcard ----
  describe('with staging wildcard ALLOWED_ORIGINS', () => {
    const staging = () => baseEnv({ ALLOWED_ORIGINS: 'https://*.typedcode.pages.dev' });

    it('allows the staging deployment', async () => {
      const res = await worker.fetch(preflight('https://staging.typedcode.pages.dev'), staging());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.typedcode.pages.dev');
    });

    it('allows an arbitrary PR preview subdomain', async () => {
      const res = await worker.fetch(preflight('https://feature-x.typedcode.pages.dev'), staging());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://feature-x.typedcode.pages.dev');
    });

    it('rejects a prefix-spoofing look-alike domain', async () => {
      const res = await worker.fetch(preflight('https://eviltypedcode.pages.dev'), staging());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('rejects a different project under pages.dev', async () => {
      const res = await worker.fetch(preflight('https://evil.pages.dev'), staging());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('rejects http (scheme must match the https pattern)', async () => {
      const res = await worker.fetch(preflight('http://staging.typedcode.pages.dev'), staging());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});

// ---- セキュリティヘッダ (#285 w4) ----
describe('security headers', () => {
  const env = () => baseEnv({ ALLOWED_ORIGINS: 'https://app.example.com' });
  const EXPECTED = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  } as const;

  function expectSecurityHeaders(res: Response): void {
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(res.headers.get(name), name).toBe(value);
    }
  }

  it('is set on a CORS preflight (204)', async () => {
    const res = await worker.fetch(preflight('https://app.example.com'), env());
    expect(res.status).toBe(204);
    expectSecurityHeaders(res);
  });

  it('is set on /health', async () => {
    const res = await worker.fetch(new Request('https://api.test/health'), env());
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it('is set on a 404', async () => {
    const res = await worker.fetch(new Request('https://api.test/nope'), env());
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it('is set on public-keys while keeping its Cache-Control and the CORS headers', async () => {
    const res = await worker.fetch(
      new Request('https://api.test/api/checkpoint/public-keys', { headers: { Origin: 'https://app.example.com' } }),
      env()
    );
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('GET /api/checkpoint/public-keys caching (#370)', () => {
  it('has no cacheTtlSec in the body and caches only via Cache-Control: public, max-age=3600', async () => {
    const res = await worker.fetch(new Request('https://api.test/api/checkpoint/public-keys'), baseEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body).not.toHaveProperty('cacheTtlSec');
  });
});
