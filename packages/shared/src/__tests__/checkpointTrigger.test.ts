/**
 * CheckpointManager のハイブリッドトリガ (events OR elapsed time) のテスト。
 *
 * トリガ意味論のテストなので、TypingProof は経由せず CheckpointManager を
 * 直接構築する。HashChainManager は実体を使い、`createCheckpoint` 用の
 * 最小限の StoredEvent スタブを渡す。
 */

import { describe, it, expect } from 'vitest';
import {
  CheckpointManager,
  DEFAULT_MAX_EVENTS_PER_CHECKPOINT,
  DEFAULT_MAX_CHECKPOINT_INTERVAL_MS,
} from '../typingProof/CheckpointManager.js';
import { HashChainManager } from '../typingProof/HashChainManager.js';
import type { CheckpointData, StoredEvent } from '../types.js';

const stubEvent = (eventIndex: number): StoredEvent =>
  ({
    sequence: eventIndex,
    timestamp: 1000 + eventIndex,
    type: 'contentChange',
    inputType: 'insertText',
    data: `e${eventIndex}`,
    hash: `hash-${eventIndex}`,
    previousHash: eventIndex === 0 ? null : `hash-${eventIndex - 1}`,
  } as unknown as StoredEvent);

const stubCheckpoint = (eventIndex: number): CheckpointData => ({
  eventIndex,
  hash: `hash-${eventIndex}`,
  timestamp: 1000 + eventIndex,
  contentHash: `content-${eventIndex}`,
});

const eventsUpTo = (n: number): StoredEvent[] =>
  Array.from({ length: n + 1 }, (_, i) => stubEvent(i));

describe('CheckpointManager hybrid trigger', () => {
  it('fires when default N (100) events have accumulated', () => {
    const cm = new CheckpointManager(new HashChainManager(), {
      now: () => 1000,
    });
    for (let i = 0; i < 99; i++) {
      expect(cm.shouldCreateCheckpoint(i)).toBe(false);
    }
    expect(cm.shouldCreateCheckpoint(99)).toBe(true);
  });

  it('N is configurable via maxEventsPerCheckpoint', () => {
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 5,
      now: () => 0,
    });
    expect(cm.shouldCreateCheckpoint(0)).toBe(false);
    expect(cm.shouldCreateCheckpoint(1)).toBe(false);
    expect(cm.shouldCreateCheckpoint(2)).toBe(false);
    expect(cm.shouldCreateCheckpoint(3)).toBe(false);
    expect(cm.shouldCreateCheckpoint(4)).toBe(true);
  });

  it('time trigger fires after a checkpoint + T ms elapsed', async () => {
    let clock = 1000;
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 1000,
      maxIntervalMs: 5000,
      now: () => clock,
    });
    // 最初の cp を構築 (eventIndex=0)
    await cm.createCheckpoint(0, eventsUpTo(0));

    // cp 作成から 4999ms 経過: N も T も未達
    clock = 1000 + 4999;
    expect(cm.shouldCreateCheckpoint(1)).toBe(false);

    // 5001ms 経過: T 到達
    clock = 1000 + 5001;
    expect(cm.shouldCreateCheckpoint(1)).toBe(true);
  });

  it('first event never fires via time trigger (lastCheckpointAt is null pre-first-cp)', () => {
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 1000,
      maxIntervalMs: 1,
      now: () => 1_000_000_000_000,
    });
    expect(cm.shouldCreateCheckpoint(0)).toBe(false);
  });

  it('hybrid: event trigger wins when events accumulate first', () => {
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 3,
      maxIntervalMs: 60_000,
      now: () => 0,
    });
    expect(cm.shouldCreateCheckpoint(0)).toBe(false);
    expect(cm.shouldCreateCheckpoint(1)).toBe(false);
    expect(cm.shouldCreateCheckpoint(2)).toBe(true);
  });

  it('hybrid: time trigger wins when T elapses first', async () => {
    let clock = 1000;
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 100,
      maxIntervalMs: 1000,
      now: () => clock,
    });
    await cm.createCheckpoint(0, eventsUpTo(0));

    clock = 2500; // 1500ms 経過 (T=1000 超過)
    expect(cm.shouldCreateCheckpoint(1)).toBe(true);
  });

  it('setCheckpoints rebuilds trigger state from the restored array', () => {
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 100,
      maxIntervalMs: 10_000,
      now: () => 5000,
    });
    cm.setCheckpoints([stubCheckpoint(50), stubCheckpoint(99)]);

    // last cp は eventIndex=99。eventIndex=100 → eventsSinceLast=1 → false
    expect(cm.shouldCreateCheckpoint(100)).toBe(false);
    // eventIndex=199 → eventsSinceLast=100 → true
    expect(cm.shouldCreateCheckpoint(199)).toBe(true);
  });

  it('clearCheckpoints resets trigger state', async () => {
    let clock = 1000;
    const cm = new CheckpointManager(new HashChainManager(), {
      maxEventsPerCheckpoint: 1000,
      maxIntervalMs: 1, // 即時時間トリガを誘発する設定
      now: () => clock,
    });
    await cm.createCheckpoint(0, eventsUpTo(0));
    clock = 10_000;
    // この時点では cp 作成済みなので時間トリガが効くはず
    expect(cm.shouldCreateCheckpoint(1)).toBe(true);

    cm.clearCheckpoints();
    // clear 後は最初の cp 前と同じ状態に戻り、時間トリガが封じられる
    expect(cm.shouldCreateCheckpoint(0)).toBe(false);
  });

  it('cleanupForExport drops duplicate eventIndex entries', () => {
    const cm = new CheckpointManager(new HashChainManager());
    cm.addCheckpoint(stubCheckpoint(10));
    cm.addCheckpoint(stubCheckpoint(20));
    cm.addCheckpoint({ ...stubCheckpoint(10), hash: 'duplicate-hash' });

    cm.cleanupForExport();

    const remaining = cm.getCheckpoints();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((cp) => cp.eventIndex)).toEqual([10, 20]);
    // 後勝ち (`last wins`): 同一 eventIndex の最後の登録が残る
    expect(remaining.find((cp) => cp.eventIndex === 10)?.hash).toBe('duplicate-hash');
  });

  it('CHECKPOINT_INTERVAL legacy export equals the new event default', () => {
    expect(CheckpointManager.CHECKPOINT_INTERVAL).toBe(DEFAULT_MAX_EVENTS_PER_CHECKPOINT);
    expect(DEFAULT_MAX_EVENTS_PER_CHECKPOINT).toBe(100);
    expect(DEFAULT_MAX_CHECKPOINT_INTERVAL_MS).toBe(10_000);
  });
});
