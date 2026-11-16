/**
 * EditorController が編集ごとの composition の帰属を detector に渡すことのテスト (#720)。
 *
 * 帰属は記録と同じ `event.changes` の順に 1 件ずつ同期で決める (前の change が composition の領域を
 * 動かすため)。帰属の判定そのものは `tracking/__tests__/CompositionTracker.test.ts` が見る。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ModelContentChange, ModelContentChangedEvent } from '../types.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { EditorController } = await import('../EditorController.js');
const { OperationDetector } = await import('../../tracking/OperationDetector.js');

function change(rangeOffset: number, rangeLength: number, text: string): ModelContentChange {
  return {
    rangeOffset,
    rangeLength,
    text,
    range: {
      startLineNumber: 1,
      startColumn: rangeOffset + 1,
      endLineNumber: 1,
      endColumn: rangeOffset + 1 + rangeLength,
    },
  } as ModelContentChange;
}

/** onDidChangeModelContent だけを持つ偽の editor。`emit` で内容変更を流す。 */
function fakeEditor() {
  let listener: ((e: ModelContentChangedEvent) => void) | null = null;
  return {
    editor: {
      onDidChangeModelContent: (l: (e: ModelContentChangedEvent) => void) => {
        listener = l;
        return { dispose: () => (listener = null) };
      },
    } as never,
    emit: (changes: ModelContentChange[]) =>
      listener?.({ changes, isFlush: false, isUndoing: false, isRedoing: false } as ModelContentChangedEvent),
  };
}

/** attribute の呼び出し順を記録し、決めた順の帰属を返す偽の tracker。 */
function fakeTracker(attributions: Array<'none' | 'composing' | 'committed'>) {
  const calls: string[] = [];
  return {
    calls,
    tracker: {
      attach: vi.fn(),
      detach: vi.fn(),
      attribute: (c: ModelContentChange) => {
        calls.push(`attribute:${c.text}`);
        return attributions.shift() ?? 'none';
      },
    },
  };
}

describe('EditorController composition attribution (#720)', () => {
  it('passes each change attribution to the detector in recording order', () => {
    const fake = fakeEditor();
    const { calls, tracker } = fakeTracker(['composing', 'none']);
    const detector = new OperationDetector();
    const detect = vi.spyOn(detector, 'detectOperationType');
    const recorded: string[] = [];
    const controller = new EditorController({
      operationDetector: detector,
      compositionTracker: tracker as never,
      onContentChange: (event) => {
        calls.push(`record:${event.data}`);
        recorded.push(event.inputType);
      },
    });
    controller.attach(fake.editor);

    fake.emit([change(3, 0, 'にほん'), change(40, 0, 'int x = 1;')]);

    expect(detect.mock.calls.map((call) => call[2])).toEqual(['composing', 'none']);
    expect(recorded).toEqual(['insertCompositionText', 'insertReplacementText']);
    expect(calls).toEqual(['attribute:にほん', 'record:にほん', 'attribute:int x = 1;', 'record:int x = 1;']);
  });

  it('classifies without composition when no tracker is given', () => {
    const fake = fakeEditor();
    const recorded: string[] = [];
    const controller = new EditorController({
      operationDetector: new OperationDetector(),
      onContentChange: (event) => recorded.push(event.inputType),
    });
    controller.attach(fake.editor);

    fake.emit([change(3, 0, '日本')]);

    expect(recorded).toEqual(['insertReplacementText']);
  });

  it('attaches and detaches the tracker together with the controller', () => {
    const fake = fakeEditor();
    const { tracker } = fakeTracker([]);
    const controller = new EditorController({
      operationDetector: new OperationDetector(),
      compositionTracker: tracker as never,
    });

    controller.attach(fake.editor);
    controller.detach();

    expect(tracker.attach).toHaveBeenCalledWith(fake.editor);
    expect(tracker.detach).toHaveBeenCalledTimes(1);
  });
});
