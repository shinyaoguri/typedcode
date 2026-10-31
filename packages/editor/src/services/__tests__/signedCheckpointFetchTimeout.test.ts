/**
 * SignedCheckpointService の fetch タイムアウト (#324) のテスト。
 *
 * Workers が無応答だと sign の fetch が resolve せず、single-flight の `flushing` が解除されない
 * まま署名が永久に詰まる。1 回の fetch に上限を付け、タイムアウトは通常の失敗と同じ backoff
 * 再試行に合流させる (恒久失敗にはしない。ADR-0003: 再送は clientTimestamp 固定で冪等)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedCheckpointService } from '../SignedCheckpointService.js';
import { WORKERS_FETCH_TIMEOUT_MS } from '../../config/timeouts.js';
import type { CheckpointData, SessionStartToken, SignedCheckpointEnvelope } from '@typedcode/shared';

const SESSION = 'session-1';
const TAB = 'tab-1';

function makeToken(): SessionStartToken {
  return {
    payload: { sessionId: SESSION },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SessionStartToken;
}

function makeEnvelope(): SignedCheckpointEnvelope {
  return {
    payload: {
      version: 1,
      sessionId: SESSION,
      tabId: TAB,
      checkpointIndex: 0,
      eventIndex: 0,
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

/** `AbortSignal.timeout` は vitest の fake timers の対象外なので、faked な setTimeout で作り直す。 */
function useFakeAbortSignalTimeout(): void {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  });
}

/** 1 回目は無応答 (signal の abort でだけ reject)、2 回目以降は成功を返す fetch。 */
function createHangingThenOkFetch() {
  const signals: Array<AbortSignal | undefined> = [];
  const clientTimestamps: string[] = [];
  const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    clientTimestamps.push((JSON.parse(String(init?.body)) as { clientTimestamp: string }).clientTimestamp);
    if (signals.length === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ envelope: makeEnvelope() }) } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, signals, clientTimestamps };
}

describe('SignedCheckpointService fetch timeout (#324)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFakeAbortSignalTimeout();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('releases the single-flight lock after a hung sign request times out and re-sends the same checkpoint', async () => {
    const { fetchImpl, signals, clientTimestamps } = createHangingThenOkFetch();
    const attached: number[] = [];
    const service = new SignedCheckpointService({
      apiUrl: 'http://localhost:9999',
      sessionId: SESSION,
      tabId: TAB,
      getInitialEventChainHash: () => 'a'.repeat(64),
      getSessionStartToken: () => makeToken(),
      attachSignature: (eventIndex) => {
        attached.push(eventIndex);
        return true;
      },
      isOnline: () => true,
      fetchImpl,
      backoffSchedule: [10],
      maxAttemptsPerCheckpoint: 5,
    });

    service.handleNewCheckpoint(makeCheckpoint(0));
    await vi.advanceTimersByTimeAsync(WORKERS_FETCH_TIMEOUT_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // まだ無応答のまま待っている
    expect(attached).toEqual([]);

    // タイムアウト → handleFailure の backoff (10ms) → 同じ cp を再送して署名が載る
    await vi.advanceTimersByTimeAsync(1 + 10);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attached).toEqual([0]);

    // 全リクエストに signal が付き、再送は clientTimestamp 固定 (サーバ側の冪等判定に乗る)
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(clientTimestamps[1]).toBe(clientTimestamps[0]);
    service.dispose();
  });
});
