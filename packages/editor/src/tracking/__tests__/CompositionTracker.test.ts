/**
 * CompositionTracker (#720) の Monaco アダプタのテスト。
 *
 * Monaco の editor は composition / model / blur のイベントと、選択・offset だけを持つ偽物にする。
 * settling を閉じるスケジューラは注入して、タスク境界を手で進める。
 */

import { describe, expect, it } from 'vitest';
import type { ModelContentChange, ModelContentChangedEvent } from '../../editor/types.js';
import { CompositionTracker } from '../CompositionTracker.js';

type Listener = () => void;

/** `IEvent<void>` 相当: 購読と発火と、残っている購読の数。 */
function emitter() {
  const listeners = new Set<Listener>();
  return {
    event: (listener: Listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: () => {
      for (const l of [...listeners]) l();
    },
    get size() {
      return listeners.size;
    },
  };
}

/** 1 行だけの model を前提に、列 - 1 を offset とする偽の editor。 */
function fakeEditor() {
  const start = emitter();
  const end = emitter();
  const modelChange = emitter();
  const blur = emitter();
  let model: { id: string; getOffsetAt: (p: { column: number }) => number } | null = {
    id: 'model-1',
    getOffsetAt: (p) => p.column - 1,
  };
  let selection = { start: 4, end: 4 }; // 列
  const editor = {
    onDidCompositionStart: start.event,
    onDidCompositionEnd: end.event,
    onDidChangeModel: modelChange.event,
    onDidBlurEditorText: blur.event,
    getModel: () => model,
    // Monaco の Selection と同じく、向きによらず start が前・end が後ろ
    getSelection: () => ({
      getStartPosition: () => ({ lineNumber: 1, column: Math.min(selection.start, selection.end) }),
      getEndPosition: () => ({ lineNumber: 1, column: Math.max(selection.start, selection.end) }),
    }),
  };
  return {
    editor: editor as never,
    start,
    end,
    modelChange,
    blur,
    setModel(id: string | null) {
      model = id === null ? null : { id, getOffsetAt: (p) => p.column - 1 };
    },
    setSelection(startColumn: number, endColumn = startColumn) {
      selection = { start: startColumn, end: endColumn };
    },
  };
}

function change(rangeOffset: number, rangeLength: number, text: string): ModelContentChange {
  return { rangeOffset, rangeLength, text } as ModelContentChange;
}

const EDIT = { isFlush: false } as ModelContentChangedEvent;
const FLUSH = { isFlush: true } as ModelContentChangedEvent;

/** スケジューラを注入した tracker。`runSettle()` で予約された settle を実行する。 */
function trackerWithManualSettle() {
  const pending: Array<() => void> = [];
  const tracker = new CompositionTracker({ scheduleSettle: (cb) => pending.push(cb) });
  return {
    tracker,
    runSettle: () => {
      for (const cb of pending.splice(0)) cb();
    },
    /** 予約のうち最も古い 1 件だけを実行する。 */
    runOldestSettle: () => pending.shift()?.(),
  };
}

describe('CompositionTracker (#720)', () => {
  it('attributes an edit at the caret after composition start and nothing before it', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
    // 最初の 'に' (offset 3) で caret は 4 列目 (offset 4) に動くが、偽物の選択は 4 列目のまま
    fake.setSelection(5);
    fake.start.fire();
    expect(tracker.attribute(change(4, 0, 'ほ'), EDIT)).toBe('composing');
  });

  it('takes the region from the selection at composition start (reconversion)', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.setSelection(11, 7); // 逆向きの 4 文字選択 = offset 6..10

    fake.start.fire();

    // 選択の後ろ側だけを置き換える (選択の先頭には接しない)
    expect(tracker.attribute(change(8, 2, 'か'), EDIT)).toBe('composing');
  });

  it('commits the first correlated edit after composition end', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();
    tracker.attribute(change(3, 0, 'にほん'), EDIT);

    fake.end.fire();

    expect(tracker.attribute(change(3, 3, '日本'), EDIT)).toBe('committed');
    expect(tracker.attribute(change(5, 0, '!'), EDIT)).toBe('none');
  });

  it('stops attributing once the settle task ran without a commit', () => {
    const fake = fakeEditor();
    const { tracker, runSettle } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();
    tracker.attribute(change(3, 0, 'にほん'), EDIT);
    fake.end.fire();

    runSettle();

    expect(tracker.attribute(change(6, 0, 'int main(){}'), EDIT)).toBe('none');
  });

  it('ignores a stale settle task scheduled by an earlier composition end', () => {
    const fake = fakeEditor();
    const { tracker, runOldestSettle } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();
    fake.end.fire(); // 1 回目の end の予約 (古い)
    fake.start.fire();
    tracker.attribute(change(3, 0, 'にほん'), EDIT);
    fake.end.fire(); // 2 回目の end で settling

    runOldestSettle();

    expect(tracker.attribute(change(3, 3, '日本'), EDIT)).toBe('committed');
  });

  it('schedules the settle with setTimeout by default', async () => {
    const fake = fakeEditor();
    const tracker = new CompositionTracker();
    tracker.attach(fake.editor);
    fake.start.fire();
    fake.end.fire();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracker.attribute(change(3, 0, '日本'), EDIT)).toBe('none');
  });

  it('resets when the editor model changes (tab switch)', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    fake.modelChange.fire();

    expect(tracker.attribute(change(3, 0, 'int x;'), EDIT)).toBe('none');
  });

  it('does not attribute an edit to a composition that started in another model', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    fake.setModel('model-2');

    expect(tracker.attribute(change(3, 0, 'int x;'), EDIT)).toBe('none');
  });

  it('resets when the editor text loses focus', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    fake.blur.fire();

    expect(tracker.attribute(change(3, 0, 'int x;'), EDIT)).toBe('none');
  });

  it('resets on a flush and attributes nothing to the flush itself', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    expect(tracker.attribute(change(0, 0, 'whole'), FLUSH)).toBe('none');
    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
  });

  it('starts idle when attached in the middle of a composition', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    // composition の開始は attach の前 (購読していない)
    fake.start.fire();
    tracker.attach(fake.editor);

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
    fake.end.fire();
    expect(tracker.attribute(change(3, 1, '日'), EDIT)).toBe('none');
  });

  it('starts idle when re-attached after a detach in the middle of a composition', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    tracker.detach();
    tracker.attach(fake.editor);

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
  });

  it('stops attributing and unsubscribes after detach', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    tracker.detach();
    fake.start.fire();

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
    expect([fake.start.size, fake.end.size, fake.modelChange.size, fake.blur.size]).toEqual([0, 0, 0, 0]);
  });

  it('attributes nothing when the editor has no model', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.start.fire();

    fake.setModel(null);

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
  });

  it('stays idle when a composition starts without a model', () => {
    const fake = fakeEditor();
    const { tracker } = trackerWithManualSettle();
    tracker.attach(fake.editor);
    fake.setModel(null);
    fake.start.fire();

    fake.setModel('model-1');

    expect(tracker.attribute(change(3, 0, 'に'), EDIT)).toBe('none');
  });
});
