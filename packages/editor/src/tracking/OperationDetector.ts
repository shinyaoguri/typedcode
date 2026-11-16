/**
 * OperationDetector - Monaco Editorの変更イベントから操作種別を推定
 *
 * composition 系の inputType (`insertCompositionText` / `insertFromComposition` /
 * `deleteCompositionText`) は、`CompositionTracker` が実際の composition に対応付けた編集にだけ付ける
 * (#720)。文字種 (CJK を含むか) では推定しない: composition を経ない長い直接挿入が IME の確定と
 * 分類され、一括挿入の評価を素通りしていたため。
 */

import type { InputType, DeleteDirection, TextRange, OperationResult } from '@typedcode/shared';
import type { ModelContentChange, ModelContentChangedEvent } from '../editor/types.js';
import { t } from '../i18n/index.js';
import type { CompositionAttribution } from './compositionCorrelation.js';

export class OperationDetector {
  private lastOperation: OperationResult | null = null;

  /**
   * Monaco Editorの変更イベントから操作種別を推定
   *
   * @param attribution この編集の composition への帰属 (`CompositionTracker.attribute`)。既定は `none`
   *   (composition と対応しない = 従来の分類)。
   */
  detectOperationType(
    change: ModelContentChange,
    event: ModelContentChangedEvent,
    attribution: CompositionAttribution = 'none'
  ): OperationResult {
    const { text, rangeLength, range } = change;
    const hasText = text.length > 0;
    const hasRangeLength = rangeLength > 0;

    let inputType: InputType = 'insertText';
    let operationDetail: Partial<OperationResult> = {};

    // 0. composition に対応付いた編集 (#720)。改行を含む編集は composition 中でも従来の分類に回す
    //    (IME の確定は単一行で、改行入りの塊は複数行の一括挿入として評価させる)。真正な composition には
    //    長さの上限を置かない (長い確定を一括挿入扱いにして IME を締め出さない)。
    const compositionType =
      attribution !== 'none' && !/[\r\n]/.test(text)
        ? this.detectCompositionType(attribution, hasText, hasRangeLength)
        : null;
    if (compositionType) {
      inputType = compositionType;
      operationDetail = {
        ...(hasRangeLength && { deletedLength: rangeLength }),
        ...(hasText && { insertedText: text, insertLength: text.length }),
      };
    }
    // 1. 削除操作の検出
    else if (hasRangeLength && !hasText) {
      inputType = this.detectDeleteType(change, range);
      operationDetail = {
        deletedLength: rangeLength,
        deleteDirection: this.getDeleteDirection(range),
      };
    }
    // 2. 挿入操作の検出
    else if (hasText && !hasRangeLength) {
      inputType = this.detectInsertType(text);
      operationDetail = {
        insertedText: text,
        insertLength: text.length,
      };
    }
    // 3. 置換操作の検出（範囲選択後の入力）
    else if (hasText && hasRangeLength) {
      inputType = 'replaceContent';
      operationDetail = {
        deletedLength: rangeLength,
        insertedText: text,
        insertLength: text.length,
      };
    }

    // 4. Undo/Redoの検出（ヒューリスティック）
    if (event.isUndoing) {
      inputType = 'historyUndo';
    } else if (event.isRedoing) {
      inputType = 'historyRedo';
    }

    // 5. 複数行の変更の検出
    const isMultiLine = this.isMultiLineChange(range);

    const textRange: TextRange = {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    };

    const result: OperationResult = {
      inputType,
      text: text ?? '',
      rangeOffset: change.rangeOffset,
      rangeLength: rangeLength,
      range: textRange,
      isMultiLine,
      ...operationDetail,
    };

    this.lastOperation = result;
    return result;
  }

  /**
   * composition に対応付いた編集の種別。text があれば (置換・1 文字を含む) 変換中は
   * `insertCompositionText`、確定直後の対応は `insertFromComposition`。text が無く範囲を消す編集
   * (取消・preedit の全消去) は `deleteCompositionText`。何も変えない編集は null (従来の分類)。
   */
  private detectCompositionType(
    attribution: Exclude<CompositionAttribution, 'none'>,
    hasText: boolean,
    hasRangeLength: boolean
  ): InputType | null {
    if (hasText) {
      return attribution === 'committed' ? 'insertFromComposition' : 'insertCompositionText';
    }
    if (hasRangeLength) {
      return 'deleteCompositionText';
    }
    return null;
  }

  /**
   * 削除操作の詳細な種別を推定 (advisory)
   *
   * Monaco の変更イベントは削除された文字列を持たないので、空白や単語境界は判定できない。
   * 範囲の行数と長さだけで分類する: 行をまたぐ削除は行単位の削除、同一行の 2〜49 文字は
   * 便宜的に deleteWordBackward、それ以上は deleteByCut とする (#284)。
   */
  private detectDeleteType(change: ModelContentChange, range: ModelContentChange['range']): InputType {
    const { rangeLength } = change;

    // 単一文字の削除
    if (rangeLength === 1) {
      if (range.startColumn > 1) {
        return 'deleteContentBackward';
      }
      return 'deleteContentForward';
    }

    // 行をまたぐ削除（長さによらず行単位の削除として扱う）
    if (range.startLineNumber !== range.endLineNumber) {
      return 'deleteHardLineBackward';
    }

    // 同一行内の短い範囲削除（2〜49 文字）。単語かどうかは判定できないので便宜的な分類
    if (rangeLength > 1 && rangeLength < 50) {
      return 'deleteWordBackward';
    }

    // 大量削除（範囲選択後のDelete）
    return 'deleteByCut';
  }

  /**
   * 挿入操作の詳細な種別を推定
   */
  private detectInsertType(text: string): InputType {
    // 改行の検出
    if (text === '\n' || text === '\r\n') {
      return 'insertLineBreak';
    }

    // 段落の挿入（複数改行）
    if (text.includes('\n')) {
      return 'insertParagraph';
    }

    // タブの挿入
    if (text === '\t') {
      return 'insertTab';
    }

    // 通常の文字入力
    if (text.length === 1) {
      return 'insertText';
    }

    // 複数文字の挿入（オートコンプリート・括弧の自動閉じ・直接の編集など）。文字種で IME とは
    // 推定しない (#720)。composition に対応付いた編集は detectOperationType の手前で分類済み
    if (text.length > 1) {
      return 'insertReplacementText';
    }

    return 'insertText';
  }

  /**
   * 削除方向を推定。advisory (Backspace と Delete は変更イベント上で区別できない)
   */
  private getDeleteDirection(range: ModelContentChange['range']): DeleteDirection {
    if (range.startColumn === 1) {
      return 'forward';
    }
    return 'backward';
  }

  /**
   * 複数行の変更かどうか
   */
  private isMultiLineChange(range: ModelContentChange['range']): boolean {
    return range.startLineNumber !== range.endLineNumber;
  }

  /**
   * フォーマット操作の検出（インデント調整など）
   */
  isFormattingOperation(changes: ModelContentChange[]): boolean {
    if (changes.length > 5) {
      return true;
    }

    const allIndentChanges = changes.every((change) => {
      return /^[\s\t]*$/.test(change.text);
    });

    return allIndentChanges;
  }

  /**
   * 操作の詳細な説明を生成
   */
  getOperationDescription(operation: OperationResult): string {
    const descriptions: Record<InputType, string> = {
      insertText: t('operations.input'),
      insertLineBreak: t('operations.enter'),
      insertParagraph: t('operations.multiLineChange'),
      insertTab: t('operations.tab'),
      insertFromComposition: t('operations.imeInput'),
      insertCompositionText: t('operations.imeInput'),
      deleteCompositionText: t('operations.delete'),
      deleteContentBackward: t('operations.delete'),
      deleteContentForward: t('operations.delete'),
      deleteWordBackward: t('operations.multiCharDelete'),
      deleteWordForward: t('operations.multiCharDelete'),
      deleteSoftLineBackward: t('operations.bulkDelete'),
      deleteSoftLineForward: t('operations.bulkDelete'),
      deleteHardLineBackward: t('operations.bulkDelete'),
      deleteHardLineForward: t('operations.bulkDelete'),
      deleteByDrag: t('operations.delete'),
      deleteByCut: t('operations.bulkDelete'),
      replaceContent: t('operations.replace'),
      historyUndo: t('operations.undo'),
      historyRedo: t('operations.redo'),
      insertFromPaste: t('operations.paste'),
      insertFromDrop: t('operations.drop'),
      insertFromYank: t('operations.paste'),
      insertReplacementText: t('operations.replace'),
      insertFromPasteAsQuotation: t('operations.paste'),
      insertFromInternalPaste: t('operations.internalPaste'),
    };

    return descriptions[operation.inputType] ?? operation.inputType;
  }

  /**
   * 最後の操作を取得
   */
  getLastOperation(): OperationResult | null {
    return this.lastOperation;
  }
}
