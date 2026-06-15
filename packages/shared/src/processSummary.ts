/**
 * プロセス要約 (Phase 8 W3 / ADR-0009 の周辺成果物)
 *
 * イベント列から「制作過程の見どころ」を決定的に抽出する。採点者が提出物 1 件を
 * 30 秒で掴むための要約であり、学生セルフビュー (提出前の振り返り) でも再利用する。
 *
 * 設計上の位置づけ:
 * - **中立な記述**であって疑いの指標ではない (疑いは分析層 = AnalysisSignal の責務)。
 *   pause や書き直しは著述の自然な痕跡として「教育的に見るべき場所」を指す。
 * - 純関数・決定的 (同じイベント列 → 同じ要約)。proof には焼かない (後付け再計算可能)。
 * - 実行結果 (成功/失敗) は ADR-0021 の result イベントから導出する。それ以前の proof は
 *   `hasRunResults=false` (結果不明であって 0 回ではない)。
 */

import type { StoredEvent } from './types/proof.js';
import type { CodeExecutionEventData, FocusChangeData, ReflectionNoteData } from './types/events.js';
import { isProhibitedInputType } from './typingProof/InputTypeValidator.js';
import { isStructuralEditInsert } from './typingProof/structuralEdit.js';

/** 編集の停止 (考え中) とみなす contentChange 間ギャップの下限。 */
export const PROCESS_PAUSE_THRESHOLD_MS = 10_000;
/** フォーカス復帰後、この窓内の挿入量をバーストとして測る。 */
export const PROCESS_FOCUS_BURST_WINDOW_MS = 10_000;
/** フォーカス復帰バーストを見どころに昇格させる最小挿入文字数。 */
export const PROCESS_FOCUS_BURST_MIN_CHARS = 80;
/** external-input の見どころ最大数 (それ以上は件数のみ)。 */
export const PROCESS_MAX_EXTERNAL_INPUT_MOMENTS = 20;

export type ProcessMomentKind =
  | 'first-run' // 最初のコード実行
  | 'first-failed-run' // 最初の失敗した実行 (ADR-0021 の result データが要る)
  | 'first-success-after-failure' // 失敗を経た後の最初の成功 = デバッグサイクルの結実
  | 'longest-pause' // 最長の編集停止 (考え中)
  | 'largest-deletion' // 最大の削除 (書き直し)
  | 'largest-insertion' // 最大の一括挿入
  | 'focus-return-burst' // 離脱から戻った直後の大量入力
  | 'external-input'; // 外部入力 (paste/drop 等、ADR-0005 の禁止 InputType)

/** 制作過程の見どころ 1 件。イベント index で現場 (シークバー) に飛べる。 */
export interface ProcessKeyMoment {
  kind: ProcessMomentKind;
  fromEventIndex: number;
  toEventIndex?: number;
  /** 当該イベントの timestamp (performance.now 相対 ms)。 */
  timestamp: number;
  /** kind 固有の量: pause は ms、挿入/削除/バーストは文字数。first-run は無し。 */
  value?: number;
}

export interface ProcessSummary {
  totalEvents: number;
  /** 最初と最後のイベントの timestamp 差 (ms)。イベント 0/1 件なら 0。 */
  durationMs: number;
  contentChangeCount: number;
  insertedChars: number;
  deletedChars: number;
  /** 削除文字数 / 挿入文字数。挿入 0 なら null。試行錯誤の粗い指標 (中立)。 */
  deletionRatio: number | null;
  executionCount: number;
  /**
   * 実行結果 (ADR-0021) が記録されているか。false なら旧ビルドの proof で
   * runSuccessCount / runFailureCount は常に 0 (結果不明であって 0 回ではない)。
   */
  hasRunResults: boolean;
  runSuccessCount: number;
  /** failure (非 0 exit) + error (実行基盤例外)。aborted は数えない。 */
  runFailureCount: number;
  /** PROCESS_PAUSE_THRESHOLD_MS を超えた編集停止の回数。 */
  pauseCount: number;
  longestPauseMs: number | null;
  focusLossCount: number;
  externalInputCount: number;
  /** 提出前セルフレビューの振り返りノート (ADR-0022)。チェーン由来で改ざん耐性あり。 */
  reflectionNotes: string[];
  moments: ProcessKeyMoment[];
}

/**
 * イベント列からプロセス要約を抽出する (純関数・決定的)。
 */
export function summarizeProcess(events: readonly StoredEvent[]): ProcessSummary {
  const moments: ProcessKeyMoment[] = [];

  let contentChangeCount = 0;
  let insertedChars = 0;
  let deletedChars = 0;
  let executionCount = 0;
  let runSuccessCount = 0;
  let runFailureCount = 0;
  let hasRunResults = false;
  let pauseCount = 0;
  let focusLossCount = 0;
  let externalInputCount = 0;
  const reflectionNotes: string[] = [];

  let firstRun: ProcessKeyMoment | null = null;
  let firstFailedRun: ProcessKeyMoment | null = null;
  let firstSuccessAfterFailure: ProcessKeyMoment | null = null;
  let longestPause: ProcessKeyMoment | null = null;
  let largestDeletion: ProcessKeyMoment | null = null;
  let largestInsertion: ProcessKeyMoment | null = null;
  let largestFocusBurst: ProcessKeyMoment | null = null;
  const externalMoments: ProcessKeyMoment[] = [];

  let lastContentChange: { index: number; timestamp: number } | null = null;
  // 連続削除ラン (Backspace 連打は 1 文字ずつの contentChange で来るため束ねる)。
  // 純挿入イベントで締める。最大の書き直しはこのラン合計で測る (単発 1 文字ではなく)。
  let delRun: { fromIndex: number; lastIndex: number; chars: number; timestamp: number } | null = null;
  const finalizeDelRun = (): void => {
    if (delRun && delRun.chars > (largestDeletion?.value ?? 0)) {
      largestDeletion = {
        kind: 'largest-deletion',
        fromEventIndex: delRun.fromIndex,
        toEventIndex: delRun.lastIndex !== delRun.fromIndex ? delRun.lastIndex : undefined,
        timestamp: delRun.timestamp,
        value: delRun.chars,
      };
    }
    delRun = null;
  };
  /** フォーカス復帰直後のバースト積算 (復帰イベントごとに 1 つ)。 */
  let pendingBurst: {
    refocusIndex: number;
    refocusTimestamp: number;
    chars: number;
    lastIndex: number;
  } | null = null;
  let focusLost = false;

  // 閉じたバースト窓を見どころへ昇格させる (閾値以上かつ現最大を超えたときのみ)。
  const promoteBurst = (
    burst: typeof pendingBurst,
    current: ProcessKeyMoment | null
  ): ProcessKeyMoment | null => {
    if (burst && burst.chars >= PROCESS_FOCUS_BURST_MIN_CHARS && burst.chars > (current?.value ?? 0)) {
      return {
        kind: 'focus-return-burst',
        fromEventIndex: burst.refocusIndex,
        toEventIndex: burst.lastIndex,
        timestamp: burst.refocusTimestamp,
        value: burst.chars,
      };
    }
    return current;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    switch (event.type) {
      case 'contentChange': {
        contentChangeCount++;

        const inserted = typeof event.data === 'string' ? event.data.length : 0;
        const deleted = event.rangeLength ?? 0;
        insertedChars += inserted;
        deletedChars += deleted;

        // 削除ランの蓄積: 削除を含むイベントで伸ばし、純挿入 (削除なし) で締める。
        if (deleted > 0) {
          if (delRun) {
            delRun.chars += deleted;
            delRun.lastIndex = i;
          } else {
            delRun = { fromIndex: i, lastIndex: i, chars: deleted, timestamp: event.timestamp };
          }
        } else if (inserted > 0) {
          finalizeDelRun();
        }
        if (inserted > 1 && inserted > (largestInsertion?.value ?? 0)) {
          largestInsertion = {
            kind: 'largest-insertion',
            fromEventIndex: i,
            timestamp: event.timestamp,
            value: inserted,
          };
        }

        // 編集停止 (考え中): contentChange 同士のギャップで測る。
        // (マウス移動等は editing pause を埋めないよう無視する)
        if (lastContentChange) {
          const gap = event.timestamp - lastContentChange.timestamp;
          if (gap >= PROCESS_PAUSE_THRESHOLD_MS) {
            pauseCount++;
            if (gap > (longestPause?.value ?? 0)) {
              longestPause = {
                kind: 'longest-pause',
                fromEventIndex: lastContentChange.index,
                toEventIndex: i,
                timestamp: lastContentChange.timestamp,
                value: gap,
              };
            }
          }
        }
        lastContentChange = { index: i, timestamp: event.timestamp };

        // フォーカス復帰直後のバースト集計: 窓内の挿入文字数を積算し、窓を出たら昇格判定。
        if (pendingBurst) {
          if (event.timestamp - pendingBurst.refocusTimestamp <= PROCESS_FOCUS_BURST_WINDOW_MS) {
            pendingBurst.chars += inserted;
            pendingBurst.lastIndex = i;
          } else {
            largestFocusBurst = promoteBurst(pendingBurst, largestFocusBurst);
            pendingBurst = null;
          }
        }
        break;
      }
      case 'codeExecution': {
        const data = event.data as CodeExecutionEventData | null;
        if (data && typeof data === 'object' && data.phase === 'result') {
          // ADR-0021: 実行結果イベント。実行回数には数えない (start 側で数える)。
          hasRunResults = true;
          if (data.outcome === 'success') {
            runSuccessCount++;
            if (runFailureCount > 0 && !firstSuccessAfterFailure) {
              firstSuccessAfterFailure = {
                kind: 'first-success-after-failure',
                fromEventIndex: i,
                timestamp: event.timestamp,
              };
            }
          } else if (data.outcome === 'failure' || data.outcome === 'error') {
            runFailureCount++;
            if (!firstFailedRun) {
              firstFailedRun = { kind: 'first-failed-run', fromEventIndex: i, timestamp: event.timestamp };
            }
          }
        } else {
          // start (ADR-0021) または旧ビルドの data 無し codeExecution
          executionCount++;
          if (!firstRun) {
            firstRun = { kind: 'first-run', fromEventIndex: i, timestamp: event.timestamp };
          }
        }
        break;
      }
      case 'reflectionNote': {
        const data = event.data as ReflectionNoteData | null;
        if (data && typeof data === 'object' && typeof data.text === 'string' && data.text.length > 0) {
          reflectionNotes.push(data.text);
        }
        break;
      }
      case 'focusChange': {
        const data = event.data as FocusChangeData | null;
        if (data && typeof data === 'object' && 'focused' in data) {
          if (data.focused === false) {
            focusLossCount++;
            focusLost = true;
            largestFocusBurst = promoteBurst(pendingBurst, largestFocusBurst);
            pendingBurst = null;
          } else if (data.focused === true && focusLost) {
            pendingBurst = {
              refocusIndex: i,
              refocusTimestamp: event.timestamp,
              chars: 0,
              lastIndex: i,
            };
            focusLost = false;
          }
        }
        break;
      }
      default:
        break;
    }

    if (
      event.inputType &&
      isProhibitedInputType(event.inputType) &&
      !isStructuralEditInsert(event)
    ) {
      externalInputCount++;
      if (externalMoments.length < PROCESS_MAX_EXTERNAL_INPUT_MOMENTS) {
        externalMoments.push({
          kind: 'external-input',
          fromEventIndex: i,
          timestamp: event.timestamp,
          value: typeof event.data === 'string' ? event.data.length : undefined,
        });
      }
    }
  }

  // 末尾までバースト窓 / 削除ランが開いていた場合の確定
  largestFocusBurst = promoteBurst(pendingBurst, largestFocusBurst);
  finalizeDelRun();

  if (firstRun) moments.push(firstRun);
  if (firstFailedRun) moments.push(firstFailedRun);
  if (firstSuccessAfterFailure) moments.push(firstSuccessAfterFailure);
  if (longestPause) moments.push(longestPause);
  if (largestDeletion) moments.push(largestDeletion);
  if (largestInsertion) moments.push(largestInsertion);
  if (largestFocusBurst && (largestFocusBurst.value ?? 0) >= PROCESS_FOCUS_BURST_MIN_CHARS) {
    moments.push(largestFocusBurst);
  }
  moments.push(...externalMoments);
  moments.sort((a, b) => a.fromEventIndex - b.fromEventIndex);

  const durationMs =
    events.length >= 2 ? events[events.length - 1]!.timestamp - events[0]!.timestamp : 0;

  return {
    totalEvents: events.length,
    durationMs,
    contentChangeCount,
    insertedChars,
    deletedChars,
    deletionRatio: insertedChars > 0 ? deletedChars / insertedChars : null,
    executionCount,
    hasRunResults,
    runSuccessCount,
    runFailureCount,
    pauseCount,
    longestPauseMs: longestPause?.value ?? null,
    focusLossCount,
    externalInputCount,
    reflectionNotes,
    moments,
  };
}
