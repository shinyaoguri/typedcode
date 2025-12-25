/**
 * OperationDetector - Monaco Editorの変更イベントから操作種別を推定
 */

import type {
  InputType,
  DeleteDirection,
  TextRange,
  OperationResult,
  ModelContentChange,
  ModelContentChangedEvent,
} from './types.js';

export class OperationDetector {
  private lastOperation: OperationResult | null = null;

  /**
   * Monaco Editorの変更イベントから操作種別を推定
   */
  detectOperationType(change: ModelContentChange, event: ModelContentChangedEvent): OperationResult {
    const { text, rangeLength, range } = change;
    const hasText = text.length > 0;
    const hasRangeLength = rangeLength > 0;

    let inputType: InputType = 'insertText';
    let operationDetail: Partial<OperationResult> = {};

    // 1. 削除操作の検出
    if (hasRangeLength && !hasText) {
      inputType = this.detectDeleteType(change, range);
      operationDetail = {
        deletedLength: rangeLength,
        deleteDirection: this.getDeleteDirection(range)
      };
    }
    // 2. 挿入操作の検出
    else if (hasText && !hasRangeLength) {
      inputType = this.detectInsertType(text);
      operationDetail = {
        insertedText: text,
        insertLength: text.length
      };
    }
    // 3. 置換操作の検出（範囲選択後の入力）
    else if (hasText && hasRangeLength) {
      inputType = 'replaceContent';
      operationDetail = {
        deletedLength: rangeLength,
        insertedText: text,
        insertLength: text.length
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
      endColumn: range.endColumn
    };

    const result: OperationResult = {
      inputType,
      text: text ?? '',
      rangeOffset: change.rangeOffset,
      rangeLength: rangeLength,
      range: textRange,
      isMultiLine,
      ...operationDetail
    };

    this.lastOperation = result;
    return result;
  }

  /**
   * 削除操作の詳細な種別を推定
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

    // 単語単位の削除（5文字以上で空白を含まない）
    if (rangeLength > 1 && rangeLength < 50) {
      return 'deleteWordBackward';
    }

    // 行単位の削除
    if (range.startLineNumber !== range.endLineNumber) {
      return 'deleteHardLineBackward';
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

    // 複数文字の挿入（オートコンプリートなど）
    if (text.length > 1) {
      if (this.isLikelyIMEInput(text)) {
        return 'insertFromComposition';
      }
      return 'insertText';
    }

    return 'insertText';
  }

  /**
   * 削除方向を推定
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
   * IME入力の可能性を推定（日本語、中国語など）
   */
  private isLikelyIMEInput(text: string): boolean {
    // 日本語の平仮名、カタカナ、漢字
    const japaneseRegex = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;
    // 中国語の漢字
    const chineseRegex = /[\u4e00-\u9fff]/;
    // 韓国語のハングル
    const koreanRegex = /[\uac00-\ud7af]/;

    return japaneseRegex.test(text) || chineseRegex.test(text) || koreanRegex.test(text);
  }

  /**
   * フォーマット操作の検出（インデント調整など）
   */
  isFormattingOperation(changes: ModelContentChange[]): boolean {
    if (changes.length > 5) {
      return true;
    }

    const allIndentChanges = changes.every(change => {
      return /^[\s\t]*$/.test(change.text);
    });

    return allIndentChanges;
  }

  /**
   * 操作の詳細な説明を生成
   */
  getOperationDescription(operation: OperationResult): string {
    const descriptions: Record<InputType, string> = {
      'insertText': '文字入力',
      'insertLineBreak': '改行',
      'insertParagraph': '段落挿入',
      'insertTab': 'タブ挿入',
      'insertFromComposition': 'IME入力',
      'insertCompositionText': 'IME入力',
      'deleteCompositionText': 'IME削除',
      'deleteContentBackward': 'Backspace削除',
      'deleteContentForward': 'Delete削除',
      'deleteWordBackward': '単語削除（後方）',
      'deleteWordForward': '単語削除（前方）',
      'deleteSoftLineBackward': '行削除（ソフト）',
      'deleteSoftLineForward': '行削除（ソフト前方）',
      'deleteHardLineBackward': '行削除',
      'deleteHardLineForward': '行削除（前方）',
      'deleteByDrag': 'ドラッグ削除',
      'deleteByCut': '範囲削除',
      'replaceContent': 'コンテンツ置換',
      'historyUndo': 'Undo',
      'historyRedo': 'Redo',
      'insertFromPaste': 'ペースト',
      'insertFromDrop': 'ドロップ',
      'insertFromYank': 'ヤンク',
      'insertReplacementText': '置換テキスト',
      'insertFromPasteAsQuotation': '引用ペースト'
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
