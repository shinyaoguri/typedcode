/**
 * プロセス要約 (Phase 8 W3) の抽出テスト。
 * summarizeProcess は純関数なので実体を直接使う。イベントは最小限のフィールドで合成する。
 */

import { describe, expect, it } from 'vitest';
import {
  summarizeProcess,
  PROCESS_PAUSE_THRESHOLD_MS,
  PROCESS_FOCUS_BURST_MIN_CHARS,
} from '../processSummary.js';
import type { StoredEvent } from '../types/proof.js';

let seq = 0;

function makeEvent(partial: Partial<StoredEvent> & { type: StoredEvent['type']; timestamp: number }): StoredEvent {
  return {
    sequence: seq++,
    inputType: null,
    data: null,
    rangeOffset: null,
    rangeLength: null,
    range: null,
    previousHash: null,
    posw: { iterations: 10000, nonce: '0'.repeat(32), intermediateHash: '0'.repeat(64), computeTimeMs: 1 },
    hash: '0'.repeat(64),
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
    ...partial,
  } as StoredEvent;
}

function insert(timestamp: number, text: string): StoredEvent {
  return makeEvent({ type: 'contentChange', timestamp, inputType: 'insertText', data: text, rangeLength: 0 });
}

function del(timestamp: number, length: number): StoredEvent {
  return makeEvent({ type: 'contentChange', timestamp, inputType: 'deleteContentBackward', data: '', rangeLength: length });
}

function focus(timestamp: number, focused: boolean): StoredEvent {
  return makeEvent({ type: 'focusChange', timestamp, data: { focused } });
}

describe('summarizeProcess — counts', () => {
  it('returns an all-zero summary for an empty event list', () => {
    const s = summarizeProcess([]);
    expect(s.totalEvents).toBe(0);
    expect(s.durationMs).toBe(0);
    expect(s.moments).toEqual([]);
    expect(s.deletionRatio).toBeNull();
  });

  it('counts inserted and deleted characters from hashed fields (data / rangeLength)', () => {
    const s = summarizeProcess([insert(0, 'abc'), del(100, 2), insert(200, 'd')]);
    expect(s.insertedChars).toBe(4);
    expect(s.deletedChars).toBe(2);
    expect(s.deletionRatio).toBe(0.5);
    expect(s.contentChangeCount).toBe(3);
  });

  it('measures duration from first to last event timestamp', () => {
    const s = summarizeProcess([insert(1000, 'a'), insert(61_000, 'b')]);
    expect(s.durationMs).toBe(60_000);
  });
});

describe('summarizeProcess — moments', () => {
  it('records the first code execution as a first-run moment', () => {
    const s = summarizeProcess([
      insert(0, 'a'),
      makeEvent({ type: 'codeExecution', timestamp: 500 }),
      makeEvent({ type: 'codeExecution', timestamp: 900 }),
    ]);
    expect(s.executionCount).toBe(2);
    const firstRun = s.moments.find((m) => m.kind === 'first-run');
    expect(firstRun?.fromEventIndex).toBe(1);
  });

  it('detects the longest editing pause between content changes', () => {
    const gap = PROCESS_PAUSE_THRESHOLD_MS + 5_000;
    const s = summarizeProcess([insert(0, 'a'), insert(gap, 'b'), insert(gap + 100, 'c')]);
    expect(s.pauseCount).toBe(1);
    expect(s.longestPauseMs).toBe(gap);
    const pause = s.moments.find((m) => m.kind === 'longest-pause');
    expect(pause?.fromEventIndex).toBe(0);
    expect(pause?.toEventIndex).toBe(1);
  });

  it('does not let non-editing events (mouse) mask an editing pause', () => {
    const gap = PROCESS_PAUSE_THRESHOLD_MS + 1_000;
    const s = summarizeProcess([
      insert(0, 'a'),
      makeEvent({
        type: 'mousePositionChange',
        timestamp: gap / 2,
        data: { x: 1, y: 1, clientX: 1, clientY: 1, screenX: 1, screenY: 1 },
      }),
      insert(gap, 'b'),
    ]);
    expect(s.pauseCount).toBe(1);
  });

  it('aggregates consecutive deletions into one rewrite run (not a single char)', () => {
    // Backspace 連打 = 1 文字ずつの削除イベント。これを 1 つの書き直しとして束ねる。
    const s = summarizeProcess([
      insert(0, 'abcdefghij'),
      del(100, 1),
      del(200, 1),
      del(300, 1),
      del(400, 1),
      insert(500, 'X'), // 純挿入で削除ランが締まる
    ]);
    const m = s.moments.find((x) => x.kind === 'largest-deletion');
    expect(m?.fromEventIndex).toBe(1);
    expect(m?.toEventIndex).toBe(4);
    expect(m?.value).toBe(4); // 1+1+1+1 = 4 文字を 1 ランとして集計
  });

  it('keeps separate deletion runs apart when broken by an insert', () => {
    const s = summarizeProcess([
      insert(0, 'abcdef'),
      del(100, 2),
      insert(200, 'x'),
      del(300, 5), // 別ラン (こちらが最大)
      del(400, 1),
    ]);
    const m = s.moments.find((x) => x.kind === 'largest-deletion');
    expect(m?.fromEventIndex).toBe(3);
    expect(m?.value).toBe(6); // 5+1
  });

  it('records a focus-return burst when enough characters follow a refocus', () => {
    const burstText = 'x'.repeat(PROCESS_FOCUS_BURST_MIN_CHARS);
    const s = summarizeProcess([
      insert(0, 'a'),
      focus(1_000, false),
      focus(60_000, true),
      insert(61_000, burstText),
    ]);
    expect(s.focusLossCount).toBe(1);
    const m = s.moments.find((x) => x.kind === 'focus-return-burst');
    expect(m?.fromEventIndex).toBe(2);
    expect(m?.value).toBe(PROCESS_FOCUS_BURST_MIN_CHARS);
  });

  it('does not record a focus-return burst below the threshold', () => {
    const s = summarizeProcess([
      insert(0, 'a'),
      focus(1_000, false),
      focus(60_000, true),
      insert(61_000, 'short'),
    ]);
    expect(s.moments.find((x) => x.kind === 'focus-return-burst')).toBeUndefined();
  });

  it('records prohibited external input as moments with character counts', () => {
    const s = summarizeProcess([
      insert(0, 'a'),
      makeEvent({ type: 'contentChange', timestamp: 100, inputType: 'insertFromPaste', data: 'pasted!', rangeLength: 0 }),
    ]);
    expect(s.externalInputCount).toBe(1);
    const m = s.moments.find((x) => x.kind === 'external-input');
    expect(m?.fromEventIndex).toBe(1);
    expect(m?.value).toBe(7);
  });

  it('extracts the debug cycle: first failed run and first success after failure (ADR-0021)', () => {
    const run = (timestamp: number, outcome: 'success' | 'failure'): StoredEvent[] => [
      makeEvent({ type: 'codeExecution', timestamp, data: { phase: 'start', filename: 'a.c', language: 'c' } }),
      makeEvent({ type: 'codeExecution', timestamp: timestamp + 100, data: { phase: 'result', filename: 'a.c', language: 'c', outcome, exitCode: outcome === 'success' ? 0 : 1, elapsedMs: 100 } }),
    ];
    const s = summarizeProcess([...run(0, 'failure'), ...run(1000, 'failure'), ...run(2000, 'success')]);
    expect(s.executionCount).toBe(3);
    expect(s.hasRunResults).toBe(true);
    expect(s.runFailureCount).toBe(2);
    expect(s.runSuccessCount).toBe(1);
    expect(s.moments.find((m) => m.kind === 'first-failed-run')?.fromEventIndex).toBe(1);
    expect(s.moments.find((m) => m.kind === 'first-success-after-failure')?.fromEventIndex).toBe(5);
  });

  it('does not flag success-after-failure when the first run already succeeds', () => {
    const s = summarizeProcess([
      makeEvent({ type: 'codeExecution', timestamp: 0, data: { phase: 'start', filename: 'a.c', language: 'c' } }),
      makeEvent({ type: 'codeExecution', timestamp: 100, data: { phase: 'result', filename: 'a.c', language: 'c', outcome: 'success', exitCode: 0 } }),
    ]);
    expect(s.moments.find((m) => m.kind === 'first-success-after-failure')).toBeUndefined();
    expect(s.runSuccessCount).toBe(1);
  });

  it('treats legacy codeExecution events without data as run starts with unknown results', () => {
    const s = summarizeProcess([makeEvent({ type: 'codeExecution', timestamp: 0 })]);
    expect(s.executionCount).toBe(1);
    expect(s.hasRunResults).toBe(false);
    expect(s.runSuccessCount).toBe(0);
    expect(s.runFailureCount).toBe(0);
  });

  it('collects reflection notes from reflectionNote events (ADR-0022)', () => {
    const s = summarizeProcess([
      insert(0, 'a'),
      makeEvent({ type: 'reflectionNote', timestamp: 100, data: { text: '再帰で詰まったので紙に書いた' } }),
    ]);
    expect(s.reflectionNotes).toEqual(['再帰で詰まったので紙に書いた']);
  });

  it('ignores empty reflection notes', () => {
    const s = summarizeProcess([
      makeEvent({ type: 'reflectionNote', timestamp: 0, data: { text: '' } }),
    ]);
    expect(s.reflectionNotes).toEqual([]);
  });

  it('does not count internal paste (allowed input) as external input', () => {
    const s = summarizeProcess([
      makeEvent({ type: 'contentChange', timestamp: 0, inputType: 'insertFromInternalPaste', data: 'own code', rangeLength: 0 }),
    ]);
    expect(s.externalInputCount).toBe(0);
  });

  it('sorts moments by event index', () => {
    const gap = PROCESS_PAUSE_THRESHOLD_MS + 1_000;
    const s = summarizeProcess([
      insert(0, 'abcdef'),
      del(100, 4),
      insert(gap + 100, 'b'),
      makeEvent({ type: 'codeExecution', timestamp: gap + 200 }),
    ]);
    const indexes = s.moments.map((m) => m.fromEventIndex);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});
