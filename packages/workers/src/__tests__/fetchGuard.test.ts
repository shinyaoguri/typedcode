/**
 * fetch エントリの最終防衛 try/catch (#153)。
 *
 * ハンドラ内の未捕捉例外が Workers の 1101 (CORS ヘッダなし・非 JSON) に落ちると、
 * ブラウザからは不透明な CORS エラーに見え、クライアントの意図したエラー経路に乗らない。
 * 最終防衛は「どんな例外でも構造化 JSON 500 を返し、自身は絶対に throw しない」こと。
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

describe('fetch top-level guard', () => {
  it('wraps an unhandled handler exception into JSON 500 and never rethrows', async () => {
    // env の変数参照自体が throw する最悪ケース: ハンドラ内 (responder.cors) で例外が
    // 発生し、最終防衛の CORS ヘッダ計算も失敗する。それでも JSON 500 が返ること。
    const env = {} as Record<string, unknown>;
    Object.defineProperty(env, 'ALLOWED_ORIGINS', {
      get() {
        throw new Error('simulated env failure');
      },
    });
    Object.defineProperty(env, 'ENVIRONMENT', {
      get() {
        throw new Error('simulated env failure');
      },
    });

    const req = new Request('https://workers.test/api/checkpoint/public-keys', {
      method: 'GET',
      headers: { Origin: 'https://typedcode.dev' },
    });

    const res = await worker.fetch(req, env as unknown as TestEnv);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('serves /health normally with the guard in place (no behavior change on the happy path)', async () => {
    const env = { ENVIRONMENT: 'development' } as unknown as TestEnv;
    const res = await worker.fetch(new Request('https://workers.test/health'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
