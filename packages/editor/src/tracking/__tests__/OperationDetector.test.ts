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

/** 純挿入 (rangeLength 0) の変更を作る。単一行を前提にする。 */
function insertion(text: string): ModelContentChange {
  return {
    text,
    rangeOffset: 10,
    rangeLength: 0,
    range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 5 },
  } as ModelContentChange;
}

/** 置換 (rangeLength > 0 かつ text あり) の変更を作る。 */
function replacement(text: string, rangeLength: number): ModelContentChange {
  return {
    text,
    rangeOffset: 10,
    rangeLength,
    range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 5 + rangeLength },
  } as ModelContentChange;
}

/** #720 の再現入力: composition を経ずに 1 編集で入る、日本語 1 文字入りの約 350 文字の 1 行。 */
const ISSUE_720_DIRECT_INSERT = `int main(){${'int x=1;'.repeat(40)}return 0;} // あ`;

describe('OperationDetector composition attribution (#720)', () => {
  it('classifies the #720 direct insert as insertReplacementText when no composition is attributed', () => {
    expect(detect(insertion(ISSUE_720_DIRECT_INSERT)).inputType).toBe('insertReplacementText');
  });

  it('classifies short multi-character CJK inserts without composition as insertReplacementText', () => {
    for (const text of ['日本', 'にほん', '한국어', '中文输入']) {
      expect(detect(insertion(text)).inputType).toBe('insertReplacementText');
    }
  });

  it('classifies a composing preedit replacement as insertCompositionText', () => {
    const result = new OperationDetector().detectOperationType(replacement('にほん', 1), NOT_HISTORY, 'composing');

    expect(result.inputType).toBe('insertCompositionText');
    expect(result.deletedLength).toBe(1);
    expect(result.insertedText).toBe('にほん');
  });

  it('classifies a single composing character as insertCompositionText', () => {
    const result = new OperationDetector().detectOperationType(insertion('に'), NOT_HISTORY, 'composing');

    expect(result.inputType).toBe('insertCompositionText');
  });

  it('classifies a composing deletion (cancel or clearing the preedit) as deleteCompositionText', () => {
    const result = new OperationDetector().detectOperationType(deletion({ rangeLength: 3 }), NOT_HISTORY, 'composing');

    expect(result.inputType).toBe('deleteCompositionText');
    expect(result.deletedLength).toBe(3);
  });

  it('classifies the edit attributed right after the composition ended as insertFromComposition', () => {
    const result = new OperationDetector().detectOperationType(replacement('日本', 3), NOT_HISTORY, 'committed');

    expect(result.inputType).toBe('insertFromComposition');
  });

  it('keeps a long attributed commit as a composition type without a length cap', () => {
    const long = '亜'.repeat(500);
    const result = new OperationDetector().detectOperationType(replacement(long, 500), NOT_HISTORY, 'composing');

    expect(result.inputType).toBe('insertCompositionText');
  });

  it('keeps the regular classification for an attributed edit that contains a line break', () => {
    const result = new OperationDetector().detectOperationType(insertion('日本\nint x;'), NOT_HISTORY, 'composing');

    expect(result.inputType).toBe('insertParagraph');
  });

  it('lets undo and redo override a composition attribution', () => {
    const detector = new OperationDetector();
    const undo = detector.detectOperationType(
      insertion('日本'),
      { isUndoing: true, isRedoing: false } as never,
      'composing'
    );
    const redo = detector.detectOperationType(
      insertion('日本'),
      { isUndoing: false, isRedoing: true } as never,
      'committed'
    );

    expect(undo.inputType).toBe('historyUndo');
    expect(redo.inputType).toBe('historyRedo');
  });
});
