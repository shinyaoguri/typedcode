/**
 * SignedCheckpointService の firstSeenAt 突合 (#151) のテスト。
 *
 * KV は結果整合で他コロへの伝播に最大 ~60s かかるため、コロ切替に当たったリクエストは
 * サーバが existing=null と誤認し別の firstSeenAt で署名して返すことがある。verifier は
 * 全 envelope の firstSeenAt 完全一致を要求するので、その envelope を attach すると
 * 正直な proof が丸ごと fail する。クライアントは不一致 envelope を破棄して再送する。
 */

import { describe, expect, it, vi } from 'vitest';
import { SignedCheckpointService } from '../SignedCheckpointService.js';
import type { CheckpointData, SessionStartToken, SignedCheckpointEnvelope } from '@typedcode/shared';

const SESSION = 'session-1';
const TAB = 'tab-1';

/** ADR-0027: sign は token 前提。ここでは送出ゲートの検証だけなので形だけの token で足りる。 */
function makeToken(sessionId = SESSION): SessionStartToken {
  return {
    payload: { sessionId },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SessionStartToken;
}

function makeEnvelope(params: {
  checkpointIndex: number;
  eventIndex: number;
  firstSeenAt: string;
}): SignedCheckpointEnvelope {
  return {
    payload: {
      version: 1,
      sessionId: SESSION,
      tabId: TAB,
      checkpointIndex: params.checkpointIndex,
      eventIndex: params.eventIndex,
      initialEventChainHash: 'a'.repeat(64),
      chainHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64),
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      clientTimestamp: '2026-07-02T00:00:00.000Z',
      serverTimestamp: '2026-07-02T00:00:01.000Z',
      firstSeenAt: params.firstSeenAt,
      poswIterations: 1,
    },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SignedCheckpointEnvelope;
}

function makeCheckpoint(eventIndex: number): CheckpointData {
  return {
    eventIndex,
    hash: 'b'.repeat(64),
    timestamp: eventIndex * 1000,
    contentHash: 'c'.repeat(64),
  };
}

function createService(
  responses: SignedCheckpointEnvelope[],
  options: { getSessionStartToken?: () => SessionStartToken | null } = {}
) {
  const fetchCalls: number[] = [];
  const attached: Array<{ eventIndex: number; firstSeenAt: string }> = [];
  const fetchImpl = vi.fn(async () => {
    const envelope = responses[fetchCalls.length];
    fetchCalls.push(fetchCalls.length);
    return {
      ok: true,
      json: async () => ({ envelope }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const service = new SignedCheckpointService({
    apiUrl: 'http://localhost:9999',
    sessionId: SESSION,
    tabId: TAB,
    getInitialEventChainHash: () => 'a'.repeat(64),
    getSessionStartToken: options.getSessionStartToken ?? (() => makeToken()),
    attachSignature: (eventIndex, envelope) => {
      attached.push({ eventIndex, firstSeenAt: envelope.payload.firstSeenAt });
      return true;
    },
    isOnline: () => true,
    fetchImpl,
    backoffSchedule: [10],
    maxAttemptsPerCheckpoint: 5,
  });

  return { service, attached, fetchImpl };
}

describe('SignedCheckpointService firstSeenAt consistency (#151)', () => {
  it('discards an envelope whose firstSeenAt diverges from the established one and retries until it matches', async () => {
    const t0 = '2026-07-02T00:00:00.000Z';
    const t1 = '2026-07-02T00:00:09.000Z'; // 別コロが existing=null と誤認して打った別の firstSeenAt
    const { service, attached } = createService([
      makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: t0 }),
      makeEnvelope({ checkpointIndex: 1, eventIndex: 5, firstSeenAt: t1 }), // 破棄されるべき
      makeEnvelope({ checkpointIndex: 1, eventIndex: 5, firstSeenAt: t0 }), // 伝播後のリトライ
    ]);

    service.handleNewCheckpoint(makeCheckpoint(0));
    await vi.waitFor(() => expect(attached).toHaveLength(1));

    service.handleNewCheckpoint(makeCheckpoint(5));
    await vi.waitFor(() => expect(attached).toHaveLength(2), { timeout: 2000 });

    // 不一致 envelope (t1) は attach されず、最終的に t0 の envelope だけが載る
    expect(attached.map((a) => a.firstSeenAt)).toEqual([t0, t0]);
    expect(service.pendingCount()).toBe(0);
    service.dispose();
  });

  it('adopts the first envelope firstSeenAt as the session baseline', async () => {
    const t0 = '2026-07-02T01:00:00.000Z';
    const { service, attached } = createService([
      makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: t0 }),
      makeEnvelope({ checkpointIndex: 1, eventIndex: 3, firstSeenAt: t0 }),
    ]);

    service.handleNewCheckpoint(makeCheckpoint(0));
    service.handleNewCheckpoint(makeCheckpoint(3));
    await vi.waitFor(() => expect(attached).toHaveLength(2), { timeout: 2000 });
    expect(attached.map((a) => a.firstSeenAt)).toEqual([t0, t0]);
    service.dispose();
  });

  it('seeds the baseline from restored signed checkpoints', async () => {
    const t0 = '2026-07-02T02:00:00.000Z';
    const tOther = '2026-07-02T02:00:30.000Z';
    const { service, attached } = createService([
      makeEnvelope({ checkpointIndex: 1, eventIndex: 9, firstSeenAt: tOther }), // 破棄されるべき
      makeEnvelope({ checkpointIndex: 1, eventIndex: 9, firstSeenAt: t0 }),
    ]);

    // 復元: 署名済み cp (firstSeenAt=t0) + 未署名 cp
    const signedCp: CheckpointData = {
      ...makeCheckpoint(0),
      signature: makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: t0 }),
    };
    await service.restore([signedCp, makeCheckpoint(9)]);

    await vi.waitFor(() => expect(attached).toHaveLength(1), { timeout: 2000 });
    expect(attached[0]!.firstSeenAt).toBe(t0);
    service.dispose();
  });
});

describe('SignedCheckpointService session token gate (ADR-0027 / #136)', () => {
  it('does not send sign requests while no session token is available', async () => {
    const { service, fetchImpl } = createService(
      [makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: '2026-07-02T00:00:00.000Z' })],
      { getSessionStartToken: () => null }
    );
    service.handleNewCheckpoint(makeCheckpoint(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(1); // 破棄せず待機 (token 到着で再開できる)
    service.dispose();
  });

  it('resumes pending signatures once a token arrives (retryPendingSignatures)', async () => {
    let token: SessionStartToken | null = null;
    const { service, attached } = createService(
      [makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: '2026-07-02T00:00:00.000Z' })],
      { getSessionStartToken: () => token }
    );
    service.handleNewCheckpoint(makeCheckpoint(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attached).toHaveLength(0);

    token = makeToken(); // exam の best-effort 取得が後から成功したケース
    service.retryPendingSignatures();
    await vi.waitFor(() => expect(attached).toHaveLength(1), { timeout: 2000 });
    expect(service.pendingCount()).toBe(0);
    service.dispose();
  });

  it('sends the session token alongside the checkpoint input', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        json: async () => ({
          envelope: makeEnvelope({ checkpointIndex: 0, eventIndex: 0, firstSeenAt: '2026-07-02T00:00:00.000Z' }),
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const service = new SignedCheckpointService({
      apiUrl: 'http://localhost:9999',
      sessionId: SESSION,
      tabId: TAB,
      getInitialEventChainHash: () => 'a'.repeat(64),
      getSessionStartToken: () => makeToken(),
      attachSignature: () => true,
      isOnline: () => true,
      fetchImpl,
      backoffSchedule: [10],
      maxAttemptsPerCheckpoint: 5,
    });
    service.handleNewCheckpoint(makeCheckpoint(0));
    await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 2000 });
    expect((bodies[0] as { sessionStartToken?: unknown }).sessionStartToken).toMatchObject({
      payload: { sessionId: SESSION },
    });
    service.dispose();
  });

  it('gives up permanently and drains the queue when the server rejects the token as invalid', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 'TOKEN_INVALID', error: 'Session start token is invalid' }),
    })) as unknown as typeof fetch;
    const service = new SignedCheckpointService({
      apiUrl: 'http://localhost:9999',
      sessionId: SESSION,
      tabId: TAB,
      getInitialEventChainHash: () => 'a'.repeat(64),
      getSessionStartToken: () => makeToken(),
      attachSignature: () => true,
      isOnline: () => true,
      fetchImpl,
      backoffSchedule: [10],
      maxAttemptsPerCheckpoint: 5,
    });
    service.handleNewCheckpoint(makeCheckpoint(0));
    await vi.waitFor(() => expect(service.pendingCount()).toBe(0), { timeout: 2000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 恒久拒否はリトライしない
    // 後続の checkpoint も送らない (export の waitForFlush も空回りしない)
    service.handleNewCheckpoint(makeCheckpoint(5));
    const wait = await service.waitForFlush(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait.flushed).toBe(false);
    service.dispose();
  });
});
