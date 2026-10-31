/**
 * OperationDetector の削除操作の分類テスト (#284)。
 *
 * Monaco の変更イベントは削除された文字列を持たないので、空白や単語境界は判定できない。
 * 分類は範囲の行数と長さだけに基づく便宜的な推定 (advisory) で、行をまたぐ削除は
 * 長さにかかわらず行単位の削除として扱う。
 */

import { describe, it, expect, vi } from 'vitest';
import type { ModelContentChange } from '../../editor/types.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { OperationDetector } = await import('../OperationDetector.js');

const NOT_HISTORY = { isUndoing: false, isRedoing: false } as never;

/** 削除 (text が空で rangeLength > 0) の変更を作る。複数行なら endLineNumber を進める。 */
function deletion(opts: { rangeLength: number; startColumn?: number; multiLine?: boolean }): ModelContentChange {
  const startColumn = opts.startColumn ?? 5;
  const multiLine = opts.multiLine ?? false;
  return {
    text: '',
    rangeOffset: 10,
    rangeLength: opts.rangeLength,
    range: {
      startLineNumber: 1,
      startColumn,
      endLineNumber: multiLine ? 3 : 1,
      endColumn: multiLine ? 2 : startColumn + opts.rangeLength,
    },
  } as ModelContentChange;
}

function detect(change: ModelContentChange) {
  return new OperationDetector().detectOperationType(change, NOT_HISTORY);
}

describe('OperationDetector delete classification (#284)', () => {
  it('classifies a short multi-line deletion as deleteHardLineBackward', () => {
    expect(detect(deletion({ rangeLength: 10, multiLine: true })).inputType).toBe('deleteHardLineBackward');
  });

  it('classifies a multi-line deletion of 50 or more characters as deleteHardLineBackward', () => {
    expect(detect(deletion({ rangeLength: 200, multiLine: true })).inputType).toBe('deleteHardLineBackward');
  });

  it('classifies a same-line deletion of 2 to 49 characters as deleteWordBackward', () => {
    expect(detect(deletion({ rangeLength: 10 })).inputType).toBe('deleteWordBackward');
    expect(detect(deletion({ rangeLength: 49 })).inputType).toBe('deleteWordBackward');
  });

  it('classifies a same-line deletion of 50 or more characters as deleteByCut', () => {
    expect(detect(deletion({ rangeLength: 50 })).inputType).toBe('deleteByCut');
  });

  it('keeps a single-character deletion as deleteContentBackward even when the range spans lines', () => {
    expect(detect(deletion({ rangeLength: 1, multiLine: true })).inputType).toBe('deleteContentBackward');
  });

  it('treats a single-character deletion after column 1 as backward and at column 1 as forward', () => {
    const backward = detect(deletion({ rangeLength: 1, startColumn: 3 }));
    const forward = detect(deletion({ rangeLength: 1, startColumn: 1 }));

    expect(backward.inputType).toBe('deleteContentBackward');
    expect(backward.deleteDirection).toBe('backward');
    expect(forward.inputType).toBe('deleteContentForward');
    expect(forward.deleteDirection).toBe('forward');
  });

  it('reports deletedLength, deleteDirection and isMultiLine for a short multi-line deletion', () => {
    const result = detect(deletion({ rangeLength: 10, multiLine: true }));

    expect(result.deletedLength).toBe(10);
    expect(result.deleteDirection).toBe('backward');
    expect(result.isMultiLine).toBe(true);
  });
});
