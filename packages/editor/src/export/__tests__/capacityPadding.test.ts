/**
 * export の容量の測定 (#628) 用の水増し。測定の数字が実物の列の密度を写していることを固定する。
 * (できる列は検証に通らない容量の測定用で、ここでは正しさではなく形だけを見る。)
 */

import { describe, it, expect } from 'vitest';
import type { CheckpointData, StoredEvent } from '@typedcode/shared';
import { buildCapacityPadding } from '../capacityPadding.js';

function ev(sequence: number, type: string, data: unknown = null): StoredEvent {
  return {
    sequence,
    timestamp: sequence * 10,
    type,
    inputType: null,
    data,
    rangeOffset: null,
    rangeLength: null,
    range: null,
    previousHash: `p${sequence}`,
    posw: { iterations: 1, nonce: 'n', intermediateHash: 'h', computeTimeMs: 0 },
    hash: `h${sequence}`,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  } as unknown as StoredEvent;
}

/** #0 と起動時の 1 件 + 本体 4 件 (keyDown / contentChange / contentSnapshot / keyUp) */
const BASE: StoredEvent[] = [
  ev(0, 'humanAttestation'),
  ev(1, 'environmentProbe'),
  ev(2, 'keyDown'),
  ev(3, 'contentChange', 'a'),
  ev(4, 'contentSnapshot', 'ab'),
  ev(5, 'keyUp'),
];
const CPS: CheckpointData[] = [
  { eventIndex: 1, hash: 'h1', timestamp: 10, contentHash: '' },
  { eventIndex: 4, hash: 'h4', timestamp: 40, contentHash: 'c' },
];

describe('buildCapacityPadding', () => {
  it('reaches exactly the target count with sequences renumbered to their positions', () => {
    const { events } = buildCapacityPadding(BASE, CPS, { targetEvents: 15, bodyStart: 2 });
    expect(events).toHaveLength(15);
    expect(events.map((e) => e.sequence)).toEqual([...Array(15).keys()]);
  });

  it('replicates only the body after bodyStart, keeping the startup events once', () => {
    const { events } = buildCapacityPadding(BASE, CPS, { targetEvents: 14, bodyStart: 2 });
    expect(events.filter((e) => e.type === 'humanAttestation')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'environmentProbe')).toHaveLength(1);
    expect(events.slice(6).map((e) => e.type)).toEqual([
      'keyDown',
      'contentChange',
      'contentSnapshot',
      'keyUp',
      'keyDown',
      'contentChange',
      'contentSnapshot',
      'keyUp',
    ]);
  });

  it('keeps timestamps non-decreasing across copies', () => {
    const { events } = buildCapacityPadding(BASE, CPS, { targetEvents: 30, bodyStart: 2 });
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.timestamp).toBeGreaterThanOrEqual(events[i - 1]!.timestamp);
    }
  });

  it('replicates body checkpoints at the same density, only within the padded range', () => {
    const { checkpoints } = buildCapacityPadding(BASE, CPS, { targetEvents: 15, bodyStart: 2 });
    // 元の 2 件 + 本体の cp (eventIndex 4) を 4 件ごとに: 8, 12 (16 は範囲外)
    expect(checkpoints.map((c) => c.eventIndex)).toEqual([1, 4, 8, 12]);
  });

  it('grows contentSnapshot data in proportion to position, reaching finalSnapshotChars at the end', () => {
    const { events } = buildCapacityPadding(BASE, CPS, { targetEvents: 400, bodyStart: 2, finalSnapshotChars: 1000 });
    const snaps = events.filter((e) => e.type === 'contentSnapshot').map((e) => (e.data as string).length);
    expect(snaps[0]).toBe(2);
    // 列の中ほどの全文は末尾の約半分
    const mid = snaps[Math.floor(snaps.length / 2)]!;
    expect(mid).toBeGreaterThan(400);
    expect(mid).toBeLessThan(600);
    expect(snaps[snaps.length - 1]).toBeGreaterThan(980);
    expect(snaps[snaps.length - 1]).toBeLessThanOrEqual(1000);
    for (let i = 1; i < snaps.length; i++) expect(snaps[i]!).toBeGreaterThanOrEqual(snaps[i - 1]!);
  });

  it('returns the base unchanged when the target is not larger than the base or there is no body to replicate', () => {
    for (const options of [
      { targetEvents: 3, bodyStart: 2 },
      { targetEvents: 50, bodyStart: 99 },
    ]) {
      const { events, checkpoints } = buildCapacityPadding(BASE, CPS, options);
      expect(events).toEqual(BASE);
      expect(checkpoints).toEqual(CPS);
    }
  });

  it('gives each copy its own objects instead of sharing them with the source', () => {
    const base = [...BASE.slice(0, 3), ev(3, 'contentChange', { text: 'a' })];
    const { events } = buildCapacityPadding(base, [], { targetEvents: 10, bodyStart: 2 });
    const copyOfChange = events[5]!;
    expect(copyOfChange.type).toBe('contentChange');
    expect(copyOfChange.data).toEqual({ text: 'a' });
    expect(copyOfChange.data).not.toBe(base[3]!.data);
    expect(copyOfChange.posw).not.toBe(base[3]!.posw);
  });

  it('points each copy previousHash at the preceding event hash', () => {
    const { events } = buildCapacityPadding(BASE, CPS, { targetEvents: 15, bodyStart: 2 });
    for (let i = BASE.length; i < events.length; i++) expect(events[i]!.previousHash).toBe(events[i - 1]!.hash);
  });

  it('does not mutate the base events', () => {
    const before = JSON.stringify(BASE);
    buildCapacityPadding(BASE, CPS, { targetEvents: 50, bodyStart: 2, finalSnapshotChars: 100 });
    expect(JSON.stringify(BASE)).toBe(before);
  });
});
