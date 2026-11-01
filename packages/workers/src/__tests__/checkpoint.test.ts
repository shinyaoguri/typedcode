/**
 * /api/checkpoint/sign ハンドラのテスト。
 *
 * テスト戦略 (ADR-0003 を参照):
 * - shared の検証ロジック (validateSignedCheckpointInput, isIdempotentSigningRetry,
 *   createSignedCheckpointEnvelope) は実体を呼ぶ。
 * - KV と CorsResponder のみ in-memory モックする。
 * - 署名鍵は ECDSA-P256 で都度生成し、その公開鍵を注入 registry (第 4 引数) に載せる。
 *   getSigningKey は env の秘密 JWK が registry の公開鍵と対であることを検査する (#285) ので、
 *   env には registry と対の秘密 JWK を渡す (「偽の鍵ペアでもフローは通る」前提は成り立たない)。
 * - sessionStartToken (ADR-0027) も同じ鍵対で作り、同じ registry で信頼させる。
 *
 * Node 24 が webcrypto を global crypto.subtle として提供するため、setup file 不要。
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createSessionStartToken, verifyCheckpointSignature } from '@typedcode/shared/checkpoint';
import type { CheckpointPublicKey, SessionStartToken, SignedCheckpointInput } from '@typedcode/shared/checkpoint';
import { handleSignCheckpoint, type CheckpointEnv } from '../checkpoint.js';

// ---------- 共通ヘルパ ----------

/**
 * ADR-0027: sign は sessionStartToken 前提。token の署名は実検証されるので、
 * テストでは自前の鍵対で本物の token を作り、公開鍵を registry 注入で信頼させる。
 */
const TOKEN_KEY_ID = 'tcp-test-token-key';
let tokenRegistry: readonly CheckpointPublicKey[];
/** TOKEN_KEY_ID の公開鍵と対になる秘密 JWK (env.CHECKPOINT_SIGNING_KEY_JWK に入れる) */
let tokenPrivateJwk: string;
let validToken: SessionStartToken;
let foreignSessionToken: SessionStartToken; // 別 sessionId に発行された token
let forgedToken: SessionStartToken; // registry に居ない鍵で署名された token

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  tokenPrivateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
  tokenRegistry = [
    {
      keyId: TOKEN_KEY_ID,
      algorithm: 'ECDSA-P256',
      publicKeyJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
      status: 'active',
      validFrom: '2026-01-01T00:00:00.000Z',
    },
  ];
  const serverContext = {
    serverNonce: '0'.repeat(64),
    issuedAt: '2026-06-04T11:59:00.000Z',
    turnstileVerified: true,
    hostname: 'workers.test',
    action: 'session_start',
  };
  const signer = { keyId: TOKEN_KEY_ID, privateKey: keyPair.privateKey };
  validToken = await createSessionStartToken(
    { sessionId: 'test-session', fingerprintHash: 'f'.repeat(64) },
    serverContext,
    signer
  );
  foreignSessionToken = await createSessionStartToken(
    { sessionId: 'other-session', fingerprintHash: 'f'.repeat(64) },
    serverContext,
    signer
  );

  const forgedPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  forgedToken = await createSessionStartToken(
    { sessionId: 'test-session', fingerprintHash: 'f'.repeat(64) },
    serverContext,
    { keyId: 'tcp-unregistered', privateKey: forgedPair.privateKey }
  );
});

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
    return type === 'json' ? (JSON.parse(v) as T) : (v as unknown as T);
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

/** per-session タブ台帳の KV キー (#297: record の `session:` 名前空間から分離) */
const TAB_REGISTRY_KEY = 'tabs:test-session';

/** registry の公開鍵と**対にならない**秘密 JWK (鍵差し替えガード SIGNING_KEY_MISMATCH 用) */
async function freshKeyPair(): Promise<{ privateJwk: string; publicJwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey)),
    publicJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
  };
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

/**
 * sign リクエストを作る。ADR-0027 で token 必須になったため、object body には
 * validToken を既定で同送する。`token: null` で意図的に外し、任意の token に差し替え可。
 */
function makeRequest(body: unknown, token: SessionStartToken | null = validToken): Request {
  const finalBody =
    typeof body === 'string' || body === null || typeof body !== 'object'
      ? body
      : { ...(body as Record<string, unknown>), ...(token ? { sessionStartToken: token } : {}) };
  return new Request('https://workers.test/api/checkpoint/sign', {
    method: 'POST',
    body: typeof finalBody === 'string' ? finalBody : JSON.stringify(finalBody),
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
      CHECKPOINT_SIGNING_KEY_JWK: tokenPrivateJwk,
      CHECKPOINT_SIGNING_KEY_ID: TOKEN_KEY_ID,
    };
  });

  /** ADR-0027: 全テストで token 検証 registry を注入して呼ぶ共通ラッパー */
  const sign = (
    request: Request,
    targetEnv: CheckpointEnv = env,
    registry: readonly CheckpointPublicKey[] = tokenRegistry
  ) => handleSignCheckpoint(request, targetEnv, responder, registry);

  it('signs a fresh checkpoint and stores session state', async () => {
    const res = await sign(makeRequest(makeInput()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignResponseBody;
    expect(body.envelope.keyId).toBe(TOKEN_KEY_ID);
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);
  });

  it('signs checkpointIndex 0 independently for two tabs in the same session (multi-tab, H4)', async () => {
    // 同一 sessionId・別 tabId・同じ checkpointIndex 0。タブ毎に KV をキーイングするので
    // どちらも CHECKPOINT_CONFLICT / NON_MONOTONIC にならず署名される (class モードの N 問タブ対策)。
    const resA = await sign(makeRequest(makeInput({ tabId: 'tab-1', checkpointIndex: 0 })));
    const resB = await sign(makeRequest(makeInput({ tabId: 'tab-2', checkpointIndex: 0 })));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);
    expect(kv.store.has('session:test-session:tab-2')).toBe(true);
  });

  it('returns CACHED envelope on identical retry (idempotency, ADR-0003)', async () => {
    const input = makeInput({ clientTimestamp: '2026-06-04T12:00:00.000Z' });
    const res1 = await sign(makeRequest(input));
    const body1 = (await res1.json()) as SignResponseBody;

    // ネットワーク再送相当: clientTimestamp だけ違う、他は同一
    const retryInput = { ...input, clientTimestamp: '2026-06-04T12:00:05.000Z' };
    const res2 = await sign(makeRequest(retryInput));
    const body2 = (await res2.json()) as SignResponseBody;

    expect(res2.status).toBe(200);
    // 同じ signature が返る = 再署名されていない (冪等)
    expect(body2.envelope.signature).toBe(body1.envelope.signature);
    expect(body2.envelope.payload.serverTimestamp).toBe(body1.envelope.payload.serverTimestamp);
  });

  it('returns CHECKPOINT_CONFLICT for same index with different content', async () => {
    await sign(makeRequest(makeInput({ chainHash: 'a'.repeat(64) })));

    const res = await sign(
      makeRequest(makeInput({ chainHash: 'd'.repeat(64) })) // 同じ index, 違う chainHash
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('CHECKPOINT_CONFLICT');
  });

  it('rejects non-monotonic checkpointIndex with NON_MONOTONIC', async () => {
    await sign(makeRequest(makeInput({ checkpointIndex: 5 })));

    const res = await sign(makeRequest(makeInput({ checkpointIndex: 3 })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('NON_MONOTONIC');
  });

  it('signs the next checkpoint when index advances', async () => {
    await sign(makeRequest(makeInput({ checkpointIndex: 0 })));

    const res = await sign(
      makeRequest(
        makeInput({
          checkpointIndex: 1,
          previousSignedCheckpointHash: 'e'.repeat(64),
        })
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignResponseBody;
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
  });

  it('preserves firstSeenAt across multiple checkpoints (anti-replay anchor)', async () => {
    const res1 = await sign(makeRequest(makeInput({ checkpointIndex: 0 })));
    const body1 = (await res1.json()) as SignResponseBody;

    const res2 = await sign(
      makeRequest(makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'f'.repeat(64) }))
    );
    const body2 = (await res2.json()) as SignResponseBody;

    expect(body2.envelope.payload.firstSeenAt).toBe(body1.envelope.payload.firstSeenAt);
  });

  it('returns SIGNING_KEY_NOT_CONFIGURED when JWK env is missing', async () => {
    const brokenEnv: CheckpointEnv = { ...env, CHECKPOINT_SIGNING_KEY_JWK: undefined };
    const res = await sign(makeRequest(makeInput()), brokenEnv);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SIGNING_KEY_NOT_CONFIGURED');
  });

  it('returns SIGNING_KEY_UNKNOWN for keyId not in registry', async () => {
    const wrongEnv: CheckpointEnv = { ...env, CHECKPOINT_SIGNING_KEY_ID: 'tcp-999999-deadbe' };
    const res = await sign(makeRequest(makeInput()), wrongEnv);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SIGNING_KEY_UNKNOWN');
  });

  it('returns SCHEMA_INVALID for malformed JSON', async () => {
    const res = await sign(makeRequest('{ "broken'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SCHEMA_INVALID for missing required fields', async () => {
    const res = await sign(makeRequest({ sessionId: 'x' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SCHEMA_INVALID');
  });

  it('returns SCHEMA_INVALID for a non-hex chainHash', async () => {
    const res = await sign(makeRequest(makeInput({ chainHash: 'not-a-valid-sha256' })));
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
    const res = await sign(req);
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
    const res = await sign(req);
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
    const res = await sign(makeRequest(makeInput({ checkpointIndex: 101 })));
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SESSION_LIMIT_EXCEEDED');
  });

  it('rejects with SESSION_STATE_UNAVAILABLE when the KV read fails (must not fork firstSeenAt)', async () => {
    // 既存セッションを固定してから read を失敗させる。read 失敗を「existing = null」と
    // 混同すると既存セッションに別の firstSeenAt で署名し proof 全体が無効化される (#151/#153)。
    const res1 = await sign(makeRequest(makeInput()));
    expect(res1.status).toBe(200);

    kv.failNextGet = true;
    const res2 = await sign(
      makeRequest(makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'e'.repeat(64) }))
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
    const res = await sign(makeRequest(makeInput()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('SESSION_PERSIST_FAILED');
    // 状態は永続化されていない
    expect(kv.store.has('session:test-session:tab-1')).toBe(false);
  });

  it('still returns envelope when a LATER KV write fails (firstSeenAt already locked)', async () => {
    // 初回は成功させて firstSeenAt を KV に固定する
    const res1 = await sign(makeRequest(makeInput({ checkpointIndex: 0 })));
    expect(res1.status).toBe(200);
    expect(kv.store.has('session:test-session:tab-1')).toBe(true);

    // 2 回目の書き込みだけ失敗させる。firstSeenAt は既に固定済みなので
    // best-effort で envelope を返してよい (graceful degradation)。
    kv.failNextPut = true;
    const res2 = await sign(
      makeRequest(makeInput({ checkpointIndex: 1, previousSignedCheckpointHash: 'e'.repeat(64) }))
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as SignResponseBody;
    expect(body.envelope.signature).toMatch(/^[0-9a-f]+$/);
  });

  // ---------- sessionStartToken 前提化 (ADR-0027 / #136) ----------

  it('rejects a request without a sessionStartToken and pays no KV cost (TOKEN_REQUIRED)', async () => {
    const res = await sign(makeRequest(makeInput(), null));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('TOKEN_REQUIRED');
    // 無認証リクエストは KV に一切触れない (write 増幅 DoS を成立させない)
    expect(kv.store.size).toBe(0);
  });

  it('rejects a token signed by a key outside the registry (TOKEN_INVALID)', async () => {
    const res = await sign(makeRequest(makeInput(), forgedToken));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('TOKEN_INVALID');
    expect(kv.store.size).toBe(0);
  });

  it('rejects a token whose payload was tampered after signing (TOKEN_INVALID)', async () => {
    const tampered = {
      ...validToken,
      payload: { ...validToken.payload, fingerprintHash: '0'.repeat(64) },
    };
    const res = await sign(makeRequest(makeInput(), tampered as SessionStartToken));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('TOKEN_INVALID');
  });

  it('rejects a structurally broken token without throwing (TOKEN_INVALID)', async () => {
    const broken = { payload: {}, signature: 'zz', keyId: TOKEN_KEY_ID } as unknown as SessionStartToken;
    const res = await sign(makeRequest(makeInput(), broken));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('TOKEN_INVALID');
  });

  it('rejects a valid token issued for a different sessionId (TOKEN_SESSION_MISMATCH)', async () => {
    // 攻撃モデル: Turnstile 1 回で得た token を使い回して新規 sessionId を連打する。
    // token.payload.sessionId と input.sessionId の一致要求がこれを塞ぐ。
    const res = await sign(makeRequest(makeInput(), foreignSessionToken));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.code).toBe('TOKEN_SESSION_MISMATCH');
    expect(kv.store.size).toBe(0);
  });

  // ---------- per-session タブ上限 (ADR-0027) ----------

  it('registers each new tab in the per-session tab registry', async () => {
    await sign(makeRequest(makeInput({ tabId: 'tab-1' })));
    await sign(makeRequest(makeInput({ tabId: 'tab-2' })));
    expect(JSON.parse(kv.store.get(TAB_REGISTRY_KEY)!)).toEqual(['tab-1', 'tab-2']);
  });

  it('rejects a NEW tab beyond the per-session cap with TAB_LIMIT_EXCEEDED but keeps known tabs signable', async () => {
    // 1 Turnstile (= 1 token) から tabId 連打で KV キーを増幅させる残余ベクタの蓋。
    const fullTabs = Array.from({ length: 64 }, (_, i) => `tab-${i + 1}`);
    kv.store.set(TAB_REGISTRY_KEY, JSON.stringify(fullTabs));

    const rejected = await sign(makeRequest(makeInput({ tabId: 'tab-65' })));
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as ErrorResponseBody).code).toBe('TAB_LIMIT_EXCEEDED');

    // 台帳に既にいるタブは上限到達後も署名を継続できる
    const known = await sign(makeRequest(makeInput({ tabId: 'tab-64' })));
    expect(known.status).toBe(200);
  });

  // ---------- KV キーの名前空間と保存値の形 (#297) ----------

  it('keeps the tab registry intact when a tab is literally named "tabs"', async () => {
    // 旧キーでは台帳 `session:{sid}:tabs` と tabId=tabs の record が同じキーになり、
    // record (オブジェクト) が台帳 (string[]) として読まれて後続タブの署名が例外になった。
    const resNormal = await sign(makeRequest(makeInput({ tabId: 'normal' })));
    const resTabs = await sign(makeRequest(makeInput({ tabId: 'tabs' })));
    const resAnother = await sign(makeRequest(makeInput({ tabId: 'another' })));
    expect([resNormal.status, resTabs.status, resAnother.status]).toEqual([200, 200, 200]);
    expect(JSON.parse(kv.store.get(TAB_REGISTRY_KEY)!)).toEqual(['normal', 'tabs', 'another']);
  });

  it('rejects ids containing the key separator with SCHEMA_INVALID', async () => {
    // `a:b`/`c` と `a`/`b:c` が同じ record キー `session:a:b:c` に潰れるのを入口で塞ぐ。
    const res = await sign(makeRequest(makeInput({ sessionId: 'a:b', tabId: 'b:c' })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponseBody).code).toBe('SCHEMA_INVALID');
    expect(kv.store.size).toBe(0);
  });

  it('treats a malformed tab registry as unreadable instead of throwing', async () => {
    // 台帳は best-effort の防御線: 形が壊れていれば read 失敗と同じく cap 判定をスキップして署名を通す。
    kv.store.set(TAB_REGISTRY_KEY, JSON.stringify({ x: 1 }));
    const res = await sign(makeRequest(makeInput({ tabId: 'tab-new' })));
    expect(res.status).toBe(200);
  });

  it('rejects a malformed session record with 503 instead of throwing', async () => {
    // record を null 扱いにすると既存セッションに別の firstSeenAt で署名してしまう (#151 と同じ罠)。
    kv.store.set('session:test-session:tab-1', JSON.stringify([]));
    const res = await sign(makeRequest(makeInput({ tabId: 'tab-1' })));
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponseBody).code).toBe('SESSION_STATE_UNAVAILABLE');
  });

  // ---------- serverTimestamp の単調クランプ (#226) ----------

  describe('serverTimestamp monotonic clamp', () => {
    const T0 = Date.parse('2026-06-04T12:00:00.000Z');
    const next = { checkpointIndex: 1, previousSignedCheckpointHash: 'e'.repeat(64) } as const;

    /** Date だけを偽装する (crypto.subtle の非同期処理は実時間のまま動く) */
    function setWallClock(ms: number): void {
      vi.setSystemTime(ms);
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    async function signedTimestamp(overrides: Partial<SignedCheckpointInput>): Promise<string> {
      const res = await sign(makeRequest(makeInput(overrides)));
      expect(res.status).toBe(200);
      return ((await res.json()) as SignResponseBody).envelope.payload.serverTimestamp;
    }

    it('keeps serverTimestamp strictly increasing when the wall clock steps back between two signatures', async () => {
      setWallClock(T0);
      const first = await signedTimestamp({ checkpointIndex: 0 });
      setWallClock(T0 - 5);
      const second = await signedTimestamp(next);
      expect(first).toBe(new Date(T0).toISOString());
      expect(second).toBe(new Date(T0 + 1).toISOString());
    });

    it('bumps the second signature by 1ms when two checkpoints are signed at the same instant', async () => {
      setWallClock(T0);
      await signedTimestamp({ checkpointIndex: 0 });
      const second = await signedTimestamp(next);
      expect(second).toBe(new Date(T0 + 1).toISOString());
    });

    it('persists the clamped value as lastServerTimestamp so the next signature clamps against it', async () => {
      setWallClock(T0);
      await signedTimestamp({ checkpointIndex: 0 });
      setWallClock(T0 - 5);
      await signedTimestamp(next);
      const record = JSON.parse(kv.store.get('session:test-session:tab-1')!) as { lastServerTimestamp: string };
      expect(record.lastServerTimestamp).toBe(new Date(T0 + 1).toISOString());

      const third = await signedTimestamp({
        ...next,
        checkpointIndex: 2,
        previousSignedCheckpointHash: 'f'.repeat(64),
      });
      expect(third).toBe(new Date(T0 + 2).toISOString());
    });

    it('does not touch serverTimestamp when the clock moves forward, and logs nothing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setWallClock(T0);
      await signedTimestamp({ checkpointIndex: 0 });
      setWallClock(T0 + 10_000);
      const second = await signedTimestamp(next);
      expect(second).toBe(new Date(T0 + 10_000).toISOString());
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs that the clamp fired without exposing the sessionId', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setWallClock(T0);
      await signedTimestamp({ checkpointIndex: 0 });
      setWallClock(T0 - 5);
      await signedTimestamp(next);

      const logged = warn.mock.calls.map((args) => args.map(String).join(' '));
      expect(logged.some((line) => line.includes('serverTimestamp clamped'))).toBe(true);
      expect(logged.some((line) => line.includes('test-session'))).toBe(false);
    });

    it('returns the cached envelope unchanged on an idempotent retry even if the clock stepped back', async () => {
      setWallClock(T0);
      const input = makeInput({ checkpointIndex: 0 });
      const first = (await (await sign(makeRequest(input))).json()) as SignResponseBody;
      setWallClock(T0 - 5_000);
      const retry = (await (
        await sign(makeRequest({ ...input, clientTimestamp: '2026-06-04T12:00:05.000Z' }))
      ).json()) as SignResponseBody;
      expect(retry.envelope.signature).toBe(first.envelope.signature);
      expect(retry.envelope.payload.serverTimestamp).toBe(new Date(T0).toISOString());
    });

    it('signs with the wall clock when the stored lastServerTimestamp is unparseable', async () => {
      setWallClock(T0);
      await signedTimestamp({ checkpointIndex: 0 });
      const key = 'session:test-session:tab-1';
      const record = JSON.parse(kv.store.get(key)!) as Record<string, unknown>;
      kv.store.set(key, JSON.stringify({ ...record, lastServerTimestamp: 'garbage' }));

      setWallClock(T0 + 3);
      const second = await signedTimestamp(next);
      expect(second).toBe(new Date(T0 + 3).toISOString());
    });
  });

  // ---------- 署名鍵ガード: 鍵差し替え (#285 w1) と有効性 (#285 w5) ----------

  describe('signing key guard', () => {
    /** 注入 registry に、署名鍵 (keyId) の公開鍵エントリを足して返す。token 検証用エントリは残す */
    function registryWith(entry: CheckpointPublicKey): readonly CheckpointPublicKey[] {
      return [...tokenRegistry, entry];
    }

    async function signingFixture(overrides: Partial<CheckpointPublicKey> = {}) {
      const pair = await freshKeyPair();
      const entry: CheckpointPublicKey = {
        keyId: 'tcp-test-guard-key',
        algorithm: 'ECDSA-P256',
        publicKeyJwk: pair.publicJwk,
        status: 'active',
        validFrom: '2026-01-01T00:00:00.000Z',
        ...overrides,
      };
      const guardEnv: CheckpointEnv = {
        CHECKPOINT_SESSIONS: kv as unknown as KVNamespace,
        CHECKPOINT_SIGNING_KEY_JWK: pair.privateJwk,
        CHECKPOINT_SIGNING_KEY_ID: entry.keyId,
      };
      return { pair, entry, guardEnv };
    }

    it('rejects with SIGNING_KEY_MISMATCH and writes nothing when the env private key is not the registry key pair', async () => {
      // 同じ keyId のまま env の JWK だけ別鍵に差し替えられると、registry の公開鍵では検証できない署名が
      // 出回る。署名前に弾き、KV にも触れない。
      const other = await freshKeyPair();
      const res = await sign(makeRequest(makeInput()), { ...env, CHECKPOINT_SIGNING_KEY_JWK: other.privateJwk });
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorResponseBody;
      expect(body.code).toBe('SIGNING_KEY_MISMATCH');
      expect(body.error).toBe('Signing key is not available');
      expect(kv.store.size).toBe(0);
    });

    it('does not reuse a cached key after the env JWK is swapped under the same keyId', async () => {
      // 回帰 (#285 w1): 旧実装はキャッシュを keyId だけで引いたため、1 回目に正しい鍵で署名できた後に
      // 同じ keyId で JWK だけ差し替わっても古い鍵を返し続け (ガードを素通りし)、逆向きでも検査されなかった。
      const first = await sign(makeRequest(makeInput({ tabId: 'tab-cache' })));
      expect(first.status).toBe(200);

      const other = await freshKeyPair();
      const second = await sign(makeRequest(makeInput({ tabId: 'tab-cache-2' })), {
        ...env,
        CHECKPOINT_SIGNING_KEY_JWK: other.privateJwk,
      });
      expect(second.status).toBe(500);
      expect(((await second.json()) as ErrorResponseBody).code).toBe('SIGNING_KEY_MISMATCH');
    });

    it('signs with the rotated key (new keyId) and the envelope verifies against its registry public key', async () => {
      const { entry, guardEnv } = await signingFixture({ keyId: 'tcp-test-rotated' });
      const registry = registryWith(entry);
      const res = await sign(makeRequest(makeInput({ tabId: 'tab-rotated' })), guardEnv, registry);
      expect(res.status).toBe(200);
      const { envelope } = (await res.json()) as SignResponseBody;
      expect(envelope.keyId).toBe('tcp-test-rotated');
      const verdict = await verifyCheckpointSignature(envelope as never, registry);
      expect(verdict.valid).toBe(true);
    });

    it.each([
      ['revoked with a past revokedAt', { status: 'revoked', revokedAt: '2026-02-01T00:00:00.000Z' }],
      ['revoked without revokedAt', { status: 'revoked' }],
      ['validFrom in the future', { validFrom: '2999-01-01T00:00:00.000Z' }],
      ['validUntil in the past', { validUntil: '2026-02-01T00:00:00.000Z' }],
      ['validFrom is not a date', { validFrom: 'not-a-date' }],
    ] as const)(
      'rejects with SIGNING_KEY_INVALID and writes nothing when the signing key is %s',
      async (_name, patch) => {
        const { entry, guardEnv } = await signingFixture(patch as Partial<CheckpointPublicKey>);
        const res = await sign(makeRequest(makeInput()), guardEnv, registryWith(entry));
        expect(res.status).toBe(500);
        const body = (await res.json()) as ErrorResponseBody;
        expect(body.code).toBe('SIGNING_KEY_INVALID');
        expect(body.error).toBe('Signing key is not available');
        expect(kv.store.size).toBe(0);
      }
    );

    it('still signs with a key whose revokedAt is in the future (warns, does not block)', async () => {
      const { entry, guardEnv } = await signingFixture({ status: 'active', revokedAt: '2999-01-01T00:00:00.000Z' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await sign(makeRequest(makeInput()), guardEnv, registryWith(entry));
        expect(res.status).toBe(200);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('re-checks validity on a cache hit (a key that expires after the first signature is refused)', async () => {
      const { entry, guardEnv } = await signingFixture();
      const first = await sign(makeRequest(makeInput({ tabId: 'tab-v1' })), guardEnv, registryWith(entry));
      expect(first.status).toBe(200);

      const expired = { ...entry, validUntil: '2026-02-01T00:00:00.000Z' };
      const second = await sign(makeRequest(makeInput({ tabId: 'tab-v2' })), guardEnv, registryWith(expired));
      expect(second.status).toBe(500);
      expect(((await second.json()) as ErrorResponseBody).code).toBe('SIGNING_KEY_INVALID');
    });

    it('fails as SIGNING_ERROR without echoing the JWK text when it is not valid JSON', async () => {
      // JSON.parse のエラー文には入力の断片が含まれうる。秘密鍵をログに出さない。
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await sign(makeRequest(makeInput()), {
          ...env,
          CHECKPOINT_SIGNING_KEY_JWK: '{"d":"SECRET-D-VALUE" oops',
        });
        expect(res.status).toBe(500);
        expect(((await res.json()) as ErrorResponseBody).code).toBe('SIGNING_ERROR');
        const logged = JSON.stringify(
          errorSpy.mock.calls.map((c) => c.map((a) => (a instanceof Error ? a.message : a)))
        );
        expect(logged).not.toContain('SECRET-D-VALUE');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('never logs JWK values when the guard rejects', async () => {
      const other = await freshKeyPair();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await sign(makeRequest(makeInput()), { ...env, CHECKPOINT_SIGNING_KEY_JWK: other.privateJwk });
        const logged = JSON.stringify(
          errorSpy.mock.calls.map((c) => c.map((a) => (a instanceof Error ? a.message : a)))
        );
        const privateD = (JSON.parse(other.privateJwk) as { d: string }).d;
        expect(logged).not.toContain(privateD);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
