/**
 * tabs 行とチェーンの書き込み位置 (`tabProgress`) の重ね方 (#627)。
 *
 * 位置は 2 か所から書かれる: `appendEvent` が events と同じ transaction で `tabProgress` に、
 * `saveTab` (定期保存) がそのときのスナップショットとして tabs 行に。どちらも遅れうる
 * (定期保存のスナップショットは、その後の append より古い / 旧版の DB には `tabProgress` が無い)
 * ので、`lastWrittenEventIndex` の大きい方の位置と hash を採る。同じなら `tabProgress` を採る
 * (events と同じ transaction で書かれたほうが、events の中身と食い違わない)。
 *
 * これは表示と後方互換のための値で、復元のチェーンの続きは events 末尾の hash を正とする (#322)。
 */

import type { StoredTabData, StoredTabProgressData } from '@typedcode/shared';

export function mergeTabProgress(
  tab: StoredTabData,
  progress: StoredTabProgressData | null | undefined
): StoredTabData {
  if (!progress) return tab;
  const lastModifiedAt = Math.max(tab.lastModifiedAt, progress.lastModifiedAt);
  if (progress.lastWrittenEventIndex < tab.lastWrittenEventIndex) {
    return lastModifiedAt === tab.lastModifiedAt ? tab : { ...tab, lastModifiedAt };
  }
  return {
    ...tab,
    lastWrittenEventIndex: progress.lastWrittenEventIndex,
    currentHash: progress.currentHash,
    lastModifiedAt,
  };
}
