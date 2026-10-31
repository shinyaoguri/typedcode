/**
 * /api/session/start (ADR-0017) ハンドラのフローテスト。
 *
 * - Turnstile siteverify はグローバル fetch をモックして成功/失敗を注入する。
 * - 署名鍵は ECDSA-P256 を都度生成し、その公開鍵を registry に載せて使う。getSigningKey は
 *   env の秘密 JWK と registry の公開鍵が対であることを検査する (#285) ので、本番 registry の
 *   keyId に別鍵を紐付ける従来のやり方は使えない。`CHECKPOINT_PUBLIC_KEYS` を差し替え可能な
 *   配列に置き換え (vi.mock)、テストごとに push / splice する。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type { CheckpointPublicKey } from '@typedcode/shared/checkpoint';

const hoisted = vi.hoisted(() => ({ registry: [] as unknown[] }));

vi.mock('@typedcode/shared/checkpoint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typedcode/shared/checkpoint')>();
  return { ...actual, CHECKPOINT_PUBLIC_KEYS: hoisted.registry as readonly CheckpointPublicKey[] };
});

import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

/** テスト用 registry に載せる署名鍵の keyId */
const REGISTERED_KEY_ID = 'tcp-test-session-start';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const registry = hoisted.registry as CheckpointPublicKey[];
let signingJwk: string;
let registryEntry: CheckpointPublicKey;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  signingJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
  registryEntry = {
    keyId: REGISTERED_KEY_ID,
    algorithm: 'ECDSA-P256',
    publicKeyJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
  };
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
  registry.splice(0, registry.length, registryEntry);
});

afterEach(() => {
  registry.splice(0, registry.length);
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

  it('returns JSON 503 when the Turnstile upstream is unreachable (no uncaught 1101)', async () => {
    // siteverify への fetch が reject する一時障害。未捕捉例外 (1101) にせず 503 で返し、
    // editor が明示的なエラー経路 (非アンカーへのフォールバック) に乗れるようにする (#153)。
    globalThis.fetch = (async () => {
      throw new Error('network unreachable');
    }) as typeof fetch;
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as SessionStartResponse;
    expect(body.success).toBe(false);
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

  it('returns 500 with a fixed message when the env private key is not the registry key pair', async () => {
    // registry の公開鍵と対にならない秘密鍵で token を署名すると、検証側で全 token が無効になる。
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const otherJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', other.privateKey));
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv({ CHECKPOINT_SIGNING_KEY_JWK: otherJwk }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as SessionStartResponse;
    expect(body.success).toBe(false);
    expect(body.message).toBe('Signing key is not available');
  });

  it('returns 500 with a fixed message when the signing key is revoked in the registry', async () => {
    registry.splice(0, registry.length, {
      ...registryEntry,
      status: 'revoked',
      revokedAt: '2026-02-01T00:00:00.000Z',
    });
    const res = await worker.fetch(sessionStartReq(validBody), makeEnv());
    expect(res.status).toBe(500);
    const body = (await res.json()) as SessionStartResponse;
    expect(body.message).toBe('Signing key is not available');
  });
});
