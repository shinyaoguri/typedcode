/**
 * SignedCheckpointService の TOKEN_EXPIRED の扱い (#227)。
 *
 * sign は sessionStartToken の最大有効期間 (30 日) を過ぎると 401 TOKEN_EXPIRED を返す。
 * これは TOKEN_INVALID / TOKEN_SESSION_MISMATCH と違い恒久失敗ではない: 後から開いたタブが
 * 新しい token を持っていれば、それで同じセッションの署名は通る。よって `tokenRejected` を
 * 立てず queue を保持し、同じ token では再送せず、より新しい token が解決されたら再送する。
 * 期限切れの token しか無くても export は止めない (#306: waitForFlush は即座に抜ける)。
 */

import { describe, expect, it, vi } from 'vitest';
import { SignedCheckpointService } from '../SignedCheckpointService.js';
import type { CheckpointData, SessionStartToken, SignedCheckpointEnvelope } from '@typedcode/shared';

const SESSION = 'session-1';
const TAB = 'tab-1';

function makeToken(label: string): SessionStartToken {
  return {
    payload: { sessionId: SESSION },
    signature: `sig-${label}`,
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SessionStartToken;
}

function makeEnvelope(eventIndex: number): SignedCheckpointEnvelope {
  return {
    payload: {
      version: 1,
      sessionId: SESSION,
      tabId: TAB,
      checkpointIndex: 0,
      eventIndex,
      initialEventChainHash: 'a'.repeat(64),
      chainHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64),
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      clientTimestamp: '2026-07-02T00:00:00.000Z',
      serverTimestamp: '2026-07-02T00:00:01.000Z',
      firstSeenAt: '2026-07-02T00:00:00.000Z',
      poswIterations: 1,
    },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SignedCheckpointEnvelope;
}

function makeCheckpoint(eventIndex: number): CheckpointData {
  return { eventIndex, hash: 'b'.repeat(64), timestamp: eventIndex * 1000, contentHash: 'c'.repeat(64) };
}

/** 送った token の signature が `acceptedSignature` なら 200、それ以外は 401 TOKEN_EXPIRED を返す fetch */
function createService(initialToken: SessionStartToken, acceptedSignature: string) {
  let currentToken: SessionStartToken | null = initialToken;
  const sentSignatures: string[] = [];
  const attached: number[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { eventIndex: number; sessionStartToken: SessionStartToken };
    sentSignatures.push(body.sessionStartToken.signature);
    if (body.sessionStartToken.signature !== acceptedSignature) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: 'expired', code: 'TOKEN_EXPIRED' }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({ envelope: makeEnvelope(body.eventIndex) }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const service = new SignedCheckpointService({
    apiUrl: 'http://localhost:9999',
    sessionId: SESSION,
    tabId: TAB,
    getInitialEventChainHash: () => 'a'.repeat(64),
    getSessionStartToken: () => currentToken,
    attachSignature: (eventIndex) => {
      attached.push(eventIndex);
      return true;
    },
    isOnline: () => true,
    fetchImpl,
    backoffSchedule: [10],
    maxAttemptsPerCheckpoint: 2,
  });

  return {
    service,
    sentSignatures,
    attached,
    setToken: (t: SessionStartToken | null) => {
      currentToken = t;
    },
  };
}

describe('SignedCheckpointService TOKEN_EXPIRED (#227)', () => {
  it('keeps the queue and does not permanently disable signing when the server answers TOKEN_EXPIRED', async () => {
    const { service, sentSignatures } = createService(makeToken('old'), 'sig-new');
    service.handleNewCheckpoint(makeCheckpoint(1));
    await vi.waitFor(() => expect(sentSignatures).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(service.pendingCount()).toBe(1);
    // 恒久失敗 (tokenRejected) になっていれば queue は空にされ、新しい checkpoint も積まれたまま流れない
    service.handleNewCheckpoint(makeCheckpoint(2));
    expect(service.pendingCount()).toBe(2);
    service.dispose();
  });

  it('does not resend with the same expired token, however many checkpoints arrive or retries fire', async () => {
    const { service, sentSignatures } = createService(makeToken('old'), 'sig-new');
    service.handleNewCheckpoint(makeCheckpoint(1));
    await vi.waitFor(() => expect(sentSignatures).toHaveLength(1));
    service.handleNewCheckpoint(makeCheckpoint(2));
    service.retryPendingSignatures();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sentSignatures).toEqual(['sig-old']);
    service.dispose();
  });

  it('does not spend the attempt budget on TOKEN_EXPIRED, so the checkpoint is still signed once a newer token arrives', async () => {
    // maxAttemptsPerCheckpoint = 2: 期限切れの応答で試行回数を消費していると、新しい token が届く前に諦めて queue から落ちる
    const { service, sentSignatures, attached, setToken } = createService(makeToken('old'), 'sig-new');
    service.handleNewCheckpoint(makeCheckpoint(1));
    await vi.waitFor(() => expect(sentSignatures).toHaveLength(1));
    service.retryPendingSignatures();
    service.retryPendingSignatures();
    service.retryPendingSignatures();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.pendingCount()).toBe(1);

    setToken(makeToken('new'));
    service.retryPendingSignatures();
    await vi.waitFor(() => expect(attached).toEqual([1]));
    expect(sentSignatures).toEqual(['sig-old', 'sig-new']);
    await vi.waitFor(() => expect(service.pendingCount()).toBe(0));
    service.dispose();
  });

  it('resumes on the next checkpoint when a newer token has been resolved in the meantime', async () => {
    const { service, sentSignatures, attached, setToken } = createService(makeToken('old'), 'sig-new');
    service.handleNewCheckpoint(makeCheckpoint(1));
    await vi.waitFor(() => expect(sentSignatures).toHaveLength(1));

    setToken(makeToken('new')); // 後から開いたタブが新しい token を取得した
    service.handleNewCheckpoint(makeCheckpoint(2));
    await vi.waitFor(() => expect(attached).toEqual([1, 2]));
    service.dispose();
  });

  it('does not make waitForFlush (export) wait out the timeout when only an expired token is available', async () => {
    const { service, sentSignatures } = createService(makeToken('old'), 'sig-new');
    service.handleNewCheckpoint(makeCheckpoint(1));
    await vi.waitFor(() => expect(sentSignatures).toHaveLength(1));

    const startedAt = Date.now();
    const result = await service.waitForFlush(5000);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toEqual({ flushed: false, remaining: 1 });
    service.dispose();
  });
});
