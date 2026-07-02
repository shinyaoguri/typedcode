/**
 * /api/checkpoint/sign ハンドラのテスト。
 *
 * テスト戦略 (ADR-0003 を参照):
 * - shared の検証ロジック (validateSignedCheckpointInput, isIdempotentSigningRetry,
 *   createSignedCheckpointEnvelope) は実体を呼ぶ。
 * - KV と CorsResponder のみ in-memory モックする。
 * - 署名鍵は ECDSA-P256 で都度生成し、registry の既存 keyId に紐付けて使う。
 *   署名 = サーバが署名するロジックの検証であり、検証側の signature 検証ではないため
 *   公開鍵との整合は不要 (= 偽の鍵ペアでも handler のフローは検証可能)。
 *
 * Node 24 が webcrypto を global crypto.subtle として提供するため、setup file 不要。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SignedCheckpointInput } from '@typedcode/shared/checkpoint';
import { handleSignCheckpoint, type CheckpointEnv } from '../checkpoint.js';

// ---------- 共通ヘルパ ----------

/** registry.ts に append 済みの本番 keyId (テスト時は鍵対が違うが handler フロー検証には十分) */
const REGISTERED_KEY_ID = 'tcp-202605-fd6d42';

/** in-memory KV モック (KVNamespace の最小サブセット) */
class MockKV {
  store = new Map<string, string>();
  failNextPut = false;
  failNextGet = false;

  async get<T = unknown>(key: string, type?: 'json' | 'text'): Promise<T | null> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('simulated KV read failure');
    }
    const v = this.store.get(key);
    if (v === undefined) return null;
    return (type === 'json' ? (JSON.parse(v) as T) : (v as unknown as T));
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated KV write failure');
    }
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const responder = { cors: () => ({}) };

async function freshSigningKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return JSON.stringify(jwk);
}

function makeInput(overrides: Partial<SignedCheckpointInput> = {}): SignedCheckpointInput {
  return {
    sessionId: 'test-session',
    tabId: 'tab-1',
    checkpointIndex: 0,
    eventIndex: 99,
    initialEventChainHash: 'a'.repeat(64),
    chainHash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    previousSignedCheckpointHash: null,
    totalEventsSincePrevious: 100,
    clientTimestamp: '2026-06-04T12:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request('https://workers.test/api/checkpoint/sign', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

interface SignResponseBody {
  envelope: {
    payload: { firstSeenAt: string; serverTimestamp: string };
    signature: string;
    keyId: string;
  };
}

interface ErrorResponseBody {
  error: string;
  code: string;
}

// ---------- テスト本体 ----------

describe('handleSignCheckpoint', () => {
  let kv: MockKV;
  let env: CheckpointEnv;

  beforeEach(async () => {
    kv = new MockKV();
    env = {
      CHECKPOINT_SESSIONS: kv as unknown as KVNamespace,
      CHECKPOINT_SIGNING_KEY_JWK: await freshSigningKey(),
      CHECKPOINT_SIGNING_KEY_ID: REGISTERED_KEY_ID,
    };
  });

  it('signs a fresh checkpoint and stores session state', async () => {
    const res = await handleSignCheckpoint(makeRequest(makeInput()), env, responder);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignResponseBody;
    expect(body.envelope.keyId).toBe(REGISTERED_KEY_ID);
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);
  });

  it('signs checkpointIndex 0 independently for two tabs in the same session (multi-tab, H4)', async () => {
    // 同一 sessionId・別 tabId・同じ checkpointIndex 0。タブ毎に KV をキーイングするので
    // どちらも CHECKPOINT_CONFLICT / NON_MONOTONIC にならず署名される (class モードの N 問タブ対策)。
    const resA = await handleSignCheckpoint(
      makeRequest(makeInput({ tabId: 'tab-1', checkpointIndex: 0 })),
      env,
      responder
    );
    const resB = await handleSignCheckpoint(
      makeRequest(makeInput({ tabId: 'tab-2', checkpointIndex: 0 })),
      env,
      responder
    );
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);
    expect(kv.store.has('session:test-session:tab-2')).toBe(true);
  });

  it('returns CACHED envelope on identical retry (idempotency, ADR-0003)', async () => {
    const input = makeInput({ clientTimestamp: '2026-06-04T12:00:00.000Z' });
    const res1 = await handleSignCheckpoint(makeRequest(input), env, responder);
    const body1 = (await res1.json()) as SignResponseBody;

    // ネットワーク再送相当: clientTimestamp だけ違う、他は同一
    const retryInput = { ...input, clientTimestamp: '2026-06-04T12:00:05.000Z' };
    const res2 = await handleSignCheckpoint(makeRequest(retryInput), env, responder);
    const body2 = (await res2.json()) as SignResponseBody;

    expect(res2.status).toBe(200);
    // 同じ signature が返る = 再署名されていない (冪等)
    expect(body2.envelope.signature).toBe(body1.envelope.signature);
    expect(body2.envelope.payload.serverTimestamp).toBe(body1.envelope.payload.serverTimestamp);
  });

  it('returns CHECKPOINT_CONFLICT for same index with different content', async () => {
    await handleSignCheckpoint(makeRequest(makeInput({ chainHash: 'a'.repeat(64) })), env, responder);

    const res = await handleSignCheckpoint(
      makeRequest(makeInput({ chainHash: 'd'.repeat(64) })), // 同じ index, 違う chainHash
      env,
      responder
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('CHECKPOINT_CONFLICT');
  });

  it('rejects non-monotonic checkpointIndex with NON_MONOTONIC', async () => {
    await handleSignCheckpoint(makeRequest(makeInput({ checkpointIndex: 5 })), env, responder);

    const res = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 3 })),
      env,
      responder
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('NON_MONOTONIC');
  });

  it('signs the next checkpoint when index advances', async () => {
    await handleSignCheckpoint(makeRequest(makeInput({ checkpointIndex: 0 })), env, responder);

    const res = await handleSignCheckpoint(
      makeRequest(
        makeInput({
          checkpointIndex: 1,
          previousSignedCheckpointHash: 'e'.repeat(64),
        })
      ),
      env,
      responder
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignResponseBody;
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
  });

  it('preserves firstSeenAt across multiple checkpoints (anti-replay anchor)', async () => {
    const res1 = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 0 })),
      env,
      responder
    );
    const body1 = (await res1.json()) as SignResponseBody;

    const res2 = await handleSignCheckpoint(
      makeRequest(
        makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'f'.repeat(64) })
      ),
      env,
      responder
    );
    const body2 = (await res2.json()) as SignResponseBody;

    expect(body2.envelope.payload.firstSeenAt).toBe(body1.envelope.payload.firstSeenAt);
  });

  it('returns SIGNING_KEY_NOT_CONFIGURED when JWK env is missing', async () => {
    const brokenEnv: CheckpointEnv = { ...env, CHECKPOINT_SIGNING_KEY_JWK: undefined };
    const res = await handleSignCheckpoint(makeRequest(makeInput()), brokenEnv, responder);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SIGNING_KEY_NOT_CONFIGURED');
  });

  it('returns SIGNING_KEY_UNKNOWN for keyId not in registry', async () => {
    const wrongEnv: CheckpointEnv = { ...env, CHECKPOINT_SIGNING_KEY_ID: 'tcp-999999-deadbe' };
    const res = await handleSignCheckpoint(makeRequest(makeInput()), wrongEnv, responder);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SIGNING_KEY_UNKNOWN');
  });

  it('returns SCHEMA_INVALID for malformed JSON', async () => {
    const res = await handleSignCheckpoint(makeRequest('{ "broken'), env, responder);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SCHEMA_INVALID for missing required fields', async () => {
    const res = await handleSignCheckpoint(makeRequest({ sessionId: 'x' }), env, responder);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SCHEMA_INVALID for a non-hex chainHash', async () => {
    const res = await handleSignCheckpoint(
      makeRequest(makeInput({ chainHash: 'not-a-valid-sha256' })),
      env,
      responder
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SCHEMA_INVALID when Content-Length exceeds the body size limit', async () => {
    const req = new Request('https://workers.test/api/checkpoint/sign', {
      method: 'POST',
      body: JSON.stringify(makeInput()),
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(8 * 1024 + 1) },
    });
    const res = await handleSignCheckpoint(req, env, responder);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('rejects an oversized body even when Content-Length is understated (real-byte guard)', async () => {
    // Content-Length を小さく詐称しても、実バイト長で上限を強制する。
    const oversized = JSON.stringify({ ...makeInput(), pad: 'x'.repeat(9000) });
    const req = new Request('https://workers.test/api/checkpoint/sign', {
      method: 'POST',
      body: oversized,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
    });
    const res = await handleSignCheckpoint(req, env, responder);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SESSION_LIMIT_EXCEEDED when signedCount is at cap', async () => {
    // signedCount を上限に達した状態で事前注入
    kv.store.set(
      'session:test-session:tab-1',
      JSON.stringify({
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastCheckpointIndex: 100,
        lastServerTimestamp: '2026-01-01T00:00:00.000Z',
        signedCount: 50_000,
      })
    );
    const res = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 101 })),
      env,
      responder
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SESSION_LIMIT_EXCEEDED');
  });

  it('rejects with SESSION_STATE_UNAVAILABLE when the KV read fails (must not fork firstSeenAt)', async () => {
    // 既存セッションを固定してから read を失敗させる。read 失敗を「existing = null」と
    // 混同すると既存セッションに別の firstSeenAt で署名し proof 全体が無効化される (#151/#153)。
    const res1 = await handleSignCheckpoint(makeRequest(makeInput()), env, responder);
    expect(res1.status).toBe(200);

    kv.failNextGet = true;
    const res2 = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'e'.repeat(64) })),
      env,
      responder
    );
    expect(res2.status).toBe(503);
    const body = (await res2.json()) as ErrorResponseBody;
    expect(body.code).toBe('SESSION_STATE_UNAVAILABLE');
  });

  it('rejects with SESSION_PERSIST_FAILED when the FIRST KV write fails', async () => {
    // 初回 checkpoint の KV 書き込み失敗は致命的: firstSeenAt が固定されないまま
    // envelope を返すと、次回リクエストで別の firstSeenAt が確定し proof 全体が
    // 無効化される。よって署名済み envelope は返さずクライアントにリトライさせる。
    kv.failNextPut = true;
    const res = await handleSignCheckpoint(makeRequest(makeInput()), env, responder);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SESSION_PERSIST_FAILED');
    // 状態は永続化されていない
    expect(kv.store.has('session:test-session:tab-1')).toBe(false);
  });

  it('still returns envelope when a LATER KV write fails (firstSeenAt already locked)', async () => {
    // 初回は成功させて firstSeenAt を KV に固定する
    const res1 = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 0 })),
      env,
      responder
    );
    expect(res1.status).toBe(200);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);

    // 2 回目の書き込みだけ失敗させる。firstSeenAt は既に固定済みなので
    // best-effort で envelope を返してよい (graceful degradation)。
    kv.failNextPut = true;
    const res2 = await handleSignCheckpoint(
      makeRequest(makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'e'.repeat(64) })),
      env,
      responder
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as SignResponseBody;
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
  });
});
