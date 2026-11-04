/**
 * 撤去した経路が 404 を返すこと (#340)。
 *
 * `/api/verify-attestation` は呼び出し元が無いまま HMAC 署名の照合だけを受け付けていた (ADR-0017 で
 * deprecate)。検証側を撤去したので、有効な形の本文を投げても処理せず、ほかの未知経路と同じ 404 になる。
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

const env = {
  TURNSTILE_SECRET_KEY: 'secret',
  ENVIRONMENT: 'production',
  ALLOWED_ORIGINS: 'https://typedcode.dev',
} as unknown as TestEnv;

describe('retired routes', () => {
  it('answers POST /api/verify-attestation with 404 even for a well-formed attestation body', async () => {
    const attestation = { verified: true, score: 1, action: 'a', timestamp: 't', hostname: 'h', signature: 'sig' };
    const res = await worker.fetch(
      new Request('https://workers.test/api/verify-attestation', {
        method: 'POST',
        body: JSON.stringify({ attestation }),
        headers: { 'Content-Type': 'application/json', Origin: 'https://typedcode.dev' },
      }),
      env
    );
    expect(res.status).toBe(404);
  });
});
