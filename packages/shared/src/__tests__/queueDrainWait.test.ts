/**
 * 記録キュー排出待ちの待機ポリシー (#225) のテスト。
 *
 * 固定タイムアウトだと「キューが長いだけ」の正常なケースで諦めてしまい、export が
 * content と chain の食い違いに至る。進捗が続く限り待ち、停滞したときだけ諦めることを固定する。
 * 時計と sleep は注入し、実時間に依存させない。
 */

import { describe, expect, it } from 'vitest';
import { waitForQueueDrain, type QueueDrainProbe } from '../typingProof/queueDrain.js';

/** 各ポーリングで返す観測値を並べた台本ドリブンの probe。最後の値は以後繰り返す。 */
function scriptedProbe(script: QueueDrainProbe[]): () => QueueDrainProbe {
  let index = 0;
  return () => {
    const value = script[Math.min(index, script.length - 1)]!;
    index++;
    return value;
  };
}

/** 仮想時計: sleep するたびに指定 ms だけ時刻を進める。 */
function virtualClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('waitForQueueDrain (#225)', () => {
  it('returns immediately when the queue is already empty', async () => {
    const clock = virtualClock();
    const result = await waitForQueueDrain(scriptedProbe([{ remaining: 0, committed: 3 }]), {
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ drained: true, remaining: 0, reason: 'drained' });
  });

  it('keeps waiting past the stall window while the queue is still shrinking', async () => {
    const clock = virtualClock();
    // 1 ポーリング (1000ms) ごとに 1 件ずつ減る = 合計 4000ms かかり stall 窓 (1500ms) を超える。
    const script: QueueDrainProbe[] = [
      { remaining: 4, committed: 0 },
      { remaining: 3, committed: 1 },
      { remaining: 2, committed: 2 },
      { remaining: 1, committed: 3 },
      { remaining: 0, committed: 4 },
    ];

    const result = await waitForQueueDrain(scriptedProbe(script), {
      stallTimeoutMs: 1500,
      maxWaitMs: 60000,
      pollIntervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ drained: true, reason: 'drained' });
  });

  it('gives up with reason "stalled" when the queue stops shrinking for the stall window', async () => {
    const clock = virtualClock();
    const result = await waitForQueueDrain(scriptedProbe([{ remaining: 2, committed: 5 }]), {
      stallTimeoutMs: 1000,
      maxWaitMs: 60000,
      pollIntervalMs: 400,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ drained: false, remaining: 2, reason: 'stalled' });
  });

  it('gives up with reason "timeout" when progress continues past the overall limit', async () => {
    const clock = virtualClock();
    // 毎ポーリングで確定数が増える (= 進捗はある) が、残件は減らない状況。
    let tick = 0;
    const probe = (): QueueDrainProbe => ({ remaining: 3, committed: tick++ });

    const result = await waitForQueueDrain(probe, {
      stallTimeoutMs: 5000,
      maxWaitMs: 3000,
      pollIntervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ drained: false, remaining: 3, reason: 'timeout' });
  });

  it('counts a growing chain as progress even when new events keep the remaining count up', async () => {
    const clock = virtualClock();
    // 残件は 2 のまま (export 中の broadcast で積み増される) が確定数は伸び続ける。
    // 最小残件だけを進捗判定にすると停滞と誤判定する状況。
    const script: QueueDrainProbe[] = [
      { remaining: 2, committed: 0 },
      { remaining: 2, committed: 1 },
      { remaining: 2, committed: 2 },
      { remaining: 2, committed: 3 },
      { remaining: 0, committed: 5 },
    ];

    const result = await waitForQueueDrain(scriptedProbe(script), {
      stallTimeoutMs: 1500,
      maxWaitMs: 60000,
      pollIntervalMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ drained: true, reason: 'drained' });
  });

  it('reports the remaining count through onProgress whenever it changes', async () => {
    const clock = virtualClock();
    const seen: number[] = [];
    const script: QueueDrainProbe[] = [
      { remaining: 2, committed: 0 },
      { remaining: 2, committed: 1 },
      { remaining: 1, committed: 2 },
      { remaining: 0, committed: 3 },
    ];

    await waitForQueueDrain(scriptedProbe(script), {
      stallTimeoutMs: 5000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      onProgress: (remaining) => seen.push(remaining),
    });

    expect(seen).toEqual([2, 1, 0]);
  });

  it('reports how long it waited before giving up', async () => {
    const clock = virtualClock();
    const result = await waitForQueueDrain(scriptedProbe([{ remaining: 1, committed: 0 }]), {
      stallTimeoutMs: 1000,
      pollIntervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.waitedMs).toBe(1000);
  });
});
