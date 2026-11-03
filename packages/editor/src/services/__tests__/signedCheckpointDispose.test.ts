/**
 * SignedCheckpointService.dispose() の後始末のテスト。
 *
 * タブを閉じる (dispose) とき、backoff 待ちの再送タイマーが残ると、閉じたタブの service が
 * 後から fetch を再開しうる。dispose は queue の全エントリの retryTimer を解除する。
 * fake timers で backoff 待ちの状態を決定的に作る (実時間に依存しない)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedCheckpointService } from '../SignedCheckpointService.js';
import type { CheckpointData, SessionStartToken } from '@typedcode/shared';

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

function makeCheckpoint(eventIndex: number): CheckpointData {
  return { eventIndex, hash: 'b'.repeat(64), timestamp: eventIndex * 1000, contentHash: 'c'.repeat(64) };
}

describe('SignedCheckpointService.dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the pending backoff retry timer of a failed checkpoint so a closed tab never resumes signing', async () => {
    // 500 を返し続ける fetch: 1 回目の失敗で backoff (10 分) 待ちのエントリが queue に残る
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
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
      backoffSchedule: [600_000],
      maxAttemptsPerCheckpoint: 5,
    });

    service.handleNewCheckpoint(makeCheckpoint(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.pendingCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // backoff の再送タイマー

    service.dispose();

    expect(service.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
