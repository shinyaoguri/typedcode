/**
 * CodeExecutionController が出すイベントを EventRecorder の入力に写す (ADR-0021)。
 *
 * main.ts の配線から切り出してあるのは、`data` (phase / outcome / exitCode / elapsedMs) を
 * 落とす退行をユニットテストで捕まえるため (#491)。落とすとハッシュチェーンに結果が載らず、
 * processSummary の hasRunResults が常に「結果不明」側へ倒れる。
 */

import type { RecordEventInput } from '@typedcode/shared';
import type { CodeExecutionCallbacks } from './CodeExecutionController.js';

type CodeExecutionRecordEvent = Parameters<NonNullable<CodeExecutionCallbacks['onRecordEvent']>>[0];

export function toRecordEventInput(event: CodeExecutionRecordEvent): RecordEventInput {
  return { type: event.type, data: event.data, description: event.description };
}
