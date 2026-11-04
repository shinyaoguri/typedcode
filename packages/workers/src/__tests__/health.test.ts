/**
 * `/health` が dev の作業ツリーの識別子を名乗るのは、`DEV_WORKTREE_ID` を渡したときだけであること (#552)。
 *
 * e2e の globalSetup はこの `worktree` で「再利用しようとしている workers はこの作業ツリーのものか」を照合する。
 * staging / production は変数を持たないので、応答の形 (`{ status, environment }`) は変わらない。
 */

import { describe, it, expect } from 'vitest';
import worker from '../index.js';

type TestEnv = Parameters<typeof worker.fetch>[1];

async function health(env: Record<string, unknown>): Promise<unknown> {
  const res = await worker.fetch(new Request('https://workers.test/health'), env as unknown as TestEnv);
  expect(res.status).toBe(200);
  return res.json();
}

describe('/health worktree identity', () => {
  it('reports the worktree id passed as DEV_WORKTREE_ID', async () => {
    const body = await health({ ENVIRONMENT: 'development', DEV_WORKTREE_ID: '0123456789ab' });
    expect(body).toEqual({ status: 'ok', environment: 'development', worktree: '0123456789ab' });
  });

  it('keeps the response shape without a worktree field when DEV_WORKTREE_ID is not set', async () => {
    const body = await health({ ENVIRONMENT: 'production' });
    expect(body).toEqual({ status: 'ok', environment: 'production' });
  });
});
