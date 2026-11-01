import type { StoredTabSwitchData, TabSwitchEvent } from '@typedcode/shared';

/**
 * IndexedDB から読んだタブ切り替えレコードを追記順の `TabSwitchEvent[]` にする (#385)。
 *
 * `switchEvent.timestamp` は `TabManager` のロードごとに 0 起点の相対時刻
 * (`performance.now() - startTime`) なので、リロードをまたぐと追記順と逆になりうる。
 * このため timestamp では並べず、ストアの autoIncrement キー `id` (= 追記順) で並べる。
 * timestamp の値そのものと `tab-switches.json` の形は変えない。
 *
 * `id` が無いレコードは、autoIncrement のストアでは通常起きないが型が optional なので、
 * 防御として `id` 付きの後ろへ入力順のまま回す。timestamp で補わないのは、
 * 比較基準が混ざるとリロードをまたいだ並びが再び崩れるため。
 */
export function sortTabSwitchesByAppendOrder(stored: readonly StoredTabSwitchData[]): TabSwitchEvent[] {
  return stored
    .map((record, position) => ({ record, position }))
    .sort((a, b) => {
      const aId = a.record.id;
      const bId = b.record.id;
      if (aId === undefined && bId === undefined) return a.position - b.position;
      if (aId === undefined) return 1;
      if (bId === undefined) return -1;
      return aId - bId;
    })
    .map(({ record }) => record.switchEvent);
}
