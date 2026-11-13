/** /health は実際の署名・registry 検証と、dev の worktree 識別子を返す (#579 / #552)。 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { CheckpointPublicKey } from '@typedcode/shared/checkpoint';

const hoisted = vi.hoisted(() => ({ registry: [] as unknown[] }));
vi.mock('@typedcode/shared/checkpoint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typedcode/shared/checkpoint')>();
  return { ...actual, CHECKPOINT_PUBLIC_KEYS: hoisted.registry };
});

import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];
const registry = hoisted.registry as CheckpointPublicKey[];
let env: TestEnv;
let entry: CheckpointPublicKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  entry = {
    keyId: 'tcp-health-test',
    algorithm: 'ECDSA-P256',
    publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
  };
  env = {
    ENVIRONMENT: 'production',
    CHECKPOINT_SIGNING_KEY_ID: entry.keyId,
    CHECKPOINT_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
  } as TestEnv;
});
beforeEach(() => registry.splice(0, registry.length, { ...entry }));
afterEach(() => vi.restoreAllMocks());

const health = (overrides: Partial<TestEnv> = {}) =>
  worker.fetch(new Request('https://workers.test/health'), { ...env, ...overrides });

describe('/health signing readiness', () => {
  it('signs and verifies with the registered public key, without returning secret material', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      environment: 'production',
      signing: { ok: true, keyId: entry.keyId },
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves the dev worktree identity', async () => {
    const res = await health({ ENVIRONMENT: 'development', DEV_WORKTREE_ID: '0123456789ab' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ worktree: '0123456789ab', signing: { ok: true } });
  });

  it.each([
    [{ CHECKPOINT_SIGNING_KEY_JWK: undefined }, 'SIGNING_KEY_NOT_CONFIGURED'],
    [{ CHECKPOINT_SIGNING_KEY_ID: undefined }, 'SIGNING_KEY_NOT_CONFIGURED'],
    [{ CHECKPOINT_SIGNING_KEY_ID: 'not-registered' }, 'SIGNING_KEY_UNKNOWN'],
    [{ CHECKPOINT_SIGNING_KEY_JWK: '{secret-not-json' }, 'SIGNING_ERROR'],
  ])('returns 503 for an unavailable key (%s)', async (overrides, reason) => {
    const res = await health(overrides);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', environment: 'production', signing: { ok: false, reason } });
  });

  it('rejects a mismatched private key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const res = await health({
      CHECKPOINT_SIGNING_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ signing: { ok: false, reason: 'SIGNING_KEY_MISMATCH' } });
  });

  it('does not leak errors when signing itself throws', async () => {
    vi.spyOn(crypto.subtle, 'sign').mockRejectedValue(new Error('secret-error-detail'));
    const res = await health({ CHECKPOINT_SIGNING_KEY_JWK: `${env.CHECKPOINT_SIGNING_KEY_JWK}   ` });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'error',
      environment: 'production',
      signing: { ok: false, reason: 'SIGNING_ERROR' },
    });
  });

  it('does not report healthy when an actual signature cannot be verified', async () => {
    const jwk = JSON.parse(env.CHECKPOINT_SIGNING_KEY_JWK!) as JsonWebKey;
    vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(false);
    const res = await health({ CHECKPOINT_SIGNING_KEY_JWK: JSON.stringify({ ...jwk, ext: true }) + ' ' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ signing: { ok: false, reason: 'SIGNATURE_VERIFICATION_FAILED' } });
  });

  it('coalesces concurrent probes and caches crypto work, but checks key validity on every request', async () => {
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const jwkText = `${env.CHECKPOINT_SIGNING_KEY_JWK}  `;
    const results = await Promise.all([
      health({ CHECKPOINT_SIGNING_KEY_JWK: jwkText }),
      health({ CHECKPOINT_SIGNING_KEY_JWK: jwkText }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect((await health({ CHECKPOINT_SIGNING_KEY_JWK: jwkText })).status).toBe(200);
    expect(sign).toHaveBeenCalledTimes(1);
    registry[0] = { ...entry, validUntil: '2026-01-02T00:00:00.000Z' };
    const expired = await health({ CHECKPOINT_SIGNING_KEY_JWK: jwkText });
    expect(expired.status).toBe(503);
    expect(await expired.json()).toMatchObject({ signing: { ok: false, reason: 'SIGNING_KEY_INVALID' } });
  });
});
