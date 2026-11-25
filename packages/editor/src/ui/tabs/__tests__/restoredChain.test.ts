/**
 * 復元したイベント列を、続きを記録できる形にそろえる (#878)。
 *
 * 保存済みのイベント列に sequence の飛びがあれば、記録は飛びの手前で切り詰める。残したイベントの外を
 * 指すチェックポイント (署名済みを含む) は、verifier が `points to missing event` で拒否するので外す。
 */

import { describe, it, expect } from 'vitest';
import type { CheckpointData, StoredEvent } from '@typedcode/shared';
import { findSequenceGap, trimRestoredChain } from '../restoredChain.js';

/** 飛びの判定が読むのは sequence だけ */
function event(sequence: number): StoredEvent {
  return { sequence, hash: `hash-${sequence}` } as StoredEvent;
}

function checkpoint(eventIndex: number): CheckpointData {
  return { eventIndex, hash: `hash-${eventIndex}`, timestamp: eventIndex, contentHash: 'c'.repeat(64) };
}

const contiguous = [0, 1, 2, 3].map(event);
/** 2 が欠けた記録 */
const gapped = [0, 1, 3, 4].map(event);

describe('findSequenceGap', () => {
  it('finds nothing in a contiguous record', () => {
    expect(findSequenceGap(contiguous)).toBeNull();
  });

  it('points at the first event after the missing sequence', () => {
    expect(findSequenceGap(gapped)).toBe(2);
  });

  it('reports only the first gap when there are several', () => {
    expect(findSequenceGap([0, 2, 4].map(event))).toBe(1);
  });
});

describe('trimRestoredChain', () => {
  it('keeps a contiguous record as it is', () => {
    const trimmed = trimRestoredChain(contiguous, [checkpoint(1), checkpoint(3)]);

    expect(trimmed).toEqual({
      events: contiguous,
      checkpoints: [checkpoint(1), checkpoint(3)],
      gap: null,
      droppedCheckpointCount: 0,
    });
  });

  it('cuts the record just before the gap', () => {
    expect(trimRestoredChain(gapped, undefined).events.map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('describes where the record was cut and how many events were left out', () => {
    expect(trimRestoredChain(gapped, undefined).gap).toEqual({
      keptEventCount: 2,
      foundSequence: 3,
      truncatedEventCount: 2,
    });
  });

  it('drops the checkpoints that point past the kept events and keeps the ones before the gap', () => {
    const trimmed = trimRestoredChain(gapped, [checkpoint(1), checkpoint(2), checkpoint(3)]);

    expect([trimmed.checkpoints, trimmed.droppedCheckpointCount]).toEqual([[checkpoint(1)], 2]);
  });

  it('drops checkpoints past the events even without a gap (a truncation saved before the tab row was rewritten)', () => {
    const trimmed = trimRestoredChain([0, 1].map(event), [checkpoint(1), checkpoint(3)]);

    expect([trimmed.gap, trimmed.checkpoints]).toEqual([null, [checkpoint(1)]]);
  });
});
