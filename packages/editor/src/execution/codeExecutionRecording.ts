/**
 * CodeExecutionController が出すイベントを EventRecorder の入力に写す (ADR-0021)。
 *
 * main.ts の配線から切り出してあるのは、`data` (phase / outcome / exitCode / elapsedMs) を
 * 落とす退行をユニットテストで捕まえるため (#491)。落とすとハッシュチェーンに結果が載らず、
 * processSummary の hasRunResults が常に「結果不明」側へ倒れる。
 */

import type { RecordEventInput } from '@typedcode/shared';
import type { CodeExecutionCallbacks } from './CodeExecutionController.js';
import type { EventRecorder } from '../core/EventRecorder.js';

type CodeExecutionRecordEvent = Parameters<NonNullable<CodeExecutionCallbacks['onRecordEvent']>>[0];

export function toRecordEventInput(event: CodeExecutionRecordEvent): RecordEventInput {
  return { type: event.type, data: event.data, description: event.description };
}

/**
 * 実行イベントを、その run の所有タブ (実行を始めたタブ) の proof に記録する (#698)。
 * main.ts の onRecordEvent はこれだけを呼ぶ。表示中のタブ宛ての `EventRecorder.record` に渡すと、
 * 実行中にタブを切り替えたとき result が別タブの proof に入る。所有者の無い run は記録しない。
 */
export function recordToOwnerTab(
  recorder: Pick<EventRecorder, 'recordToTabId'> | null | undefined,
  event: CodeExecutionRecordEvent,
  ownerTabId: string | undefined
): void {
  if (ownerTabId === undefined) return;
  recorder?.recordToTabId(ownerTabId, toRecordEventInput(event));
}
