/**
 * /api/session/start (ADR-0017) ハンドラのフローテスト。
 *
 * - Turnstile siteverify はグローバル fetch をモックして成功/失敗を注入する。
 * - 署名鍵は ECDSA-P256 を都度生成し、registry の既存 keyId に紐付けて使う
 *   (handler フロー検証には十分。署名そのものの registry 照合は shared 側でテスト済み)。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

/** registry.ts に append 済みの本番 keyId */
const REGISTERED_KEY_ID = 'tcp-202605-fd6d42';

const SHA256_HEX = /^[0-9a-f]{64}$/;

let signingJwk: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  signingJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Turnstile siteverify をモックする (success と hostname を制御)。 */
function mockTurnstile(success: boolean, hostname = 'typedcode.dev', action = 'create_tab'): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success, hostname, action, challenge_ts: '2026-06-12T00:00:00.000Z' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

beforeEach(() => {
  mockTurnstile(true);
});

function makeEnv(overrides: Partial<Record<string, string>> = {}): TestEnv {
  return {
    TURNSTILE_SECRET_KEY: 'secret',
    ATTESTATION_SECRET_KEY: 'x',
    ENVIRONMENT: 'production',
    ALLOWED_ORIGINS: 'https://typedcode.dev',
    CHECKPOINT_SIGNING_KEY_JWK: signingJwk,
    CHECKPOINT_SIGNING_KEY_ID: REGISTERED_KEY_ID,
    ...overrides,
  } as unknown as TestEnv;
}

function sessionStartReq(body: unknown): Request {
  return new Request('https://workers.test/api/session/start', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
  });
}

const validBody = {
  turnstileToken: 'tt',
  sessionId: 'session-A',
  fingerprintHash: 'f'.repeat(64),
};

interface SessionStartResponse {
  success: boolean;
  message?: string;
  token?: {
    payload: {
      version: number;
      sessionId: string;
      serverNonce: string;
      fingerprintHash: string;
      issuedAt: string;
      turnstileVerified: boolean;
      poswIterations: number;
    };
    keyId: string;
    algorithm: string;
  };
}

describe('handleSessionStart (POST /api/session/start)', () => {
  it('issues a signed token with a fresh serverNonce on Turnstile success', async () => {
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionStartResponse;
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();
    expect(body.token!.payload.sessionId).toBe('session-A');
    expect(body.token!.payload.fingerprintHash).toBe('f'.repeat(64));
    expect(body.token!.payload.serverNonce).toMatch(SHA256_HEX);
    expect(body.token!.payload.turnstileVerified).toBe(true);
    expect(body.token!.payload.version).toBe(1);
    expect(body.token!.payload.poswIterations).toBe(10000);
    expect(body.token!.keyId).toBe(REGISTERED_KEY_ID);
    expect(body.token!.algorithm).toBe('ECDSA-P256');
  });

  it('issues a different serverNonce on each call (nonce is server-random)', async () => {
    const a = (await (await worker.fetch(sessionStartReq(validBody), makeEnv())).json()) as SessionStartResponse;
    const b = (await (await worker.fetch(sessionStartReq(validBody), makeEnv())).json()) as SessionStartResponse;
    expect(a.token!.payload.serverNonce).not.toBe(b.token!.payload.serverNonce);
  });

  it('returns 403 when Turnstile verification fails', async () => {
    mockTurnstile(false);
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as SessionStartResponse;
    expect(body.success).toBe(false);
  });

  it('returns 403 when Turnstile is solved on a disallowed hostname', async () => {
    mockTurnstile(true, 'evil.example.com');
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv());
    expect(res.status).toBe(403);
  });

  it('returns 400 for a missing turnstileToken', async () => {
    const res = await worker.fetch(sessionStartReq({ sessionId: 'x', fingerprintHash: 'f'.repeat(64) }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid fingerprintHash', async () => {
    const res = await worker.fetch(sessionStartReq({ ...validBody, fingerprintHash: 'not-hex' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 500 when the signing key is not configured', async () => {
    const env = makeEnv({ CHECKPOINT_SIGNING_KEY_JWK: undefined });
    const res = await worker.fetch(sessionStartReq(validBody), env);
    expect(res.status).toBe(500);
  });
});
