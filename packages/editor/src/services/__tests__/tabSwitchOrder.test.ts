/**
 * タブ切り替え履歴の復元順 (#385) のテスト。
 *
 * timestamp は TabManager のロードごとに 0 起点の相対時刻 (performance.now() - startTime) なので、
 * リロードをまたぐと追記順と逆になりうる。復元は timestamp ではなく IndexedDB の
 * autoIncrement `id` (= 追記順) で並べる。
 */

import type { StoredTabSwitchData, TabSwitchEvent } from '@typedcode/shared';
import { describe, expect, it } from 'vitest';
import { sortTabSwitchesByAppendOrder } from '../tabSwitchOrder.js';

function rec(id: number | undefined, timestamp: number): StoredTabSwitchData {
  // 並びの検査では timestamp しか見ないので、型を満たす最小限だけ置く
  const switchEvent = { timestamp } as unknown as TabSwitchEvent;
  return id === undefined ? { sessionId: 's', switchEvent } : { id, sessionId: 's', switchEvent };
}

const stamps = (events: TabSwitchEvent[]) => events.map((e) => e.timestamp);

describe('sortTabSwitchesByAppendOrder', () => {
  it('returns switches in append order even when a later switch has a smaller timestamp (reload resets the clock)', () => {
    // リロード前に 2 回 (5000, 9000)、リロード後に 1 回 (300)。timestamp 昇順だと 300 が先頭に来てしまう。
    const stored = [rec(1, 5000), rec(2, 9000), rec(3, 300)];
    expect(stamps(sortTabSwitchesByAppendOrder(stored))).toEqual([5000, 9000, 300]);
  });

  it('orders by id regardless of the order the records are handed in', () => {
    const stored = [rec(3, 300), rec(1, 5000), rec(2, 9000)];
    expect(stamps(sortTabSwitchesByAppendOrder(stored))).toEqual([5000, 9000, 300]);
  });

  it('places records without an id after identified ones, keeping their input order', () => {
    const stored = [rec(undefined, 70), rec(2, 20), rec(undefined, 10), rec(1, 40)];
    expect(stamps(sortTabSwitchesByAppendOrder(stored))).toEqual([40, 20, 70, 10]);
  });

  it('returns an empty array for no records', () => {
    expect(sortTabSwitchesByAppendOrder([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const stored = [rec(2, 1), rec(1, 2)];
    sortTabSwitchesByAppendOrder(stored);
    expect(stored.map((s) => s.id)).toEqual([2, 1]);
  });
});
