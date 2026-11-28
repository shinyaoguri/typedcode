/**
 * 復元したイベント列を、続きを記録できる形にそろえる (#878)。
 *
 * 保存済みのイベント列に sequence の飛びがあると (保存の失敗・古い版が残した DB・未知の不具合)、
 * 飛びをまたいだまま復元した記録は、その後に export しても検証に通らない。記録は飛びの手前で切り詰め、
 * 以降の入力はその続きとして記録する。飛びより後のイベントは証明に戻さない (コードは呼び出し側の
 * `TabManager` が #413 と同じ `unprovenContents` に保全して知らせる。ADR-0058)。
 *
 * チェックポイントは、残したイベントを指すものだけを残す。切り詰めた先を指すもの (署名済みを含む) を
 * 残すと、verifier が `points to missing event` で proof 全体を拒否する。
 */

import type { CheckpointData, StoredEvent } from '@typedcode/shared';

/** 見つけた飛び */
export interface RestoredSequenceGap {
  /** 残したイベント数 (= 切り詰めた位置。以降の入力はこの sequence から記録する) */
  keptEventCount: number;
  /** 飛びの直後にあったイベントの sequence (本来は `keptEventCount` のはず) */
  foundSequence: number;
  /** 外したイベント数 */
  truncatedEventCount: number;
}

export interface TrimmedRestoredChain {
  events: StoredEvent[];
  checkpoints: CheckpointData[] | undefined;
  /** 飛びが無ければ `null` */
  gap: RestoredSequenceGap | null;
  /** 残したイベントの外を指していたので外したチェックポイントの数 */
  droppedCheckpointCount: number;
}

/**
 * 最初の sequence の飛びの位置 (飛びの直後のイベントの添字) を返す。飛びが無ければ `null`。
 * 先頭が 0 でないもの (チェーンの根の欠落) はここでは見ない (別種の破損)
 */
export function findSequenceGap(events: readonly StoredEvent[]): number | null {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev && curr && curr.sequence !== prev.sequence + 1) return i;
  }
  return null;
}

/** 復元したイベント列を飛びの手前で切り詰め、残したイベントの外を指すチェックポイントを外す (純関数) */
export function trimRestoredChain(
  events: readonly StoredEvent[],
  checkpoints: readonly CheckpointData[] | undefined
): TrimmedRestoredChain {
  const gapIndex = findSequenceGap(events);
  const kept = gapIndex === null ? [...events] : events.slice(0, gapIndex);
  const gap: RestoredSequenceGap | null =
    gapIndex === null
      ? null
      : {
          keptEventCount: gapIndex,
          foundSequence: events[gapIndex]!.sequence,
          truncatedEventCount: events.length - gapIndex,
        };

  if (!checkpoints) return { events: kept, checkpoints, gap, droppedCheckpointCount: 0 };
  // 飛びが無くても、イベントの外を指すものは外す: 切り詰めを保存した後、切り詰めたチェックポイントで
  // tabs 行を書き直す前に閉じると、次の復元では飛びが見えないまま古いチェックポイントだけが残る
  const keptCheckpoints = checkpoints.filter((cp) => cp.eventIndex < kept.length);
  return {
    events: kept,
    checkpoints: keptCheckpoints,
    gap,
    droppedCheckpointCount: checkpoints.length - keptCheckpoints.length,
  };
}
