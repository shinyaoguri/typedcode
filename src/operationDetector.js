/**
 * OperationDetector - Monaco Editorの変更イベントから操作種別を推定
 */

export class OperationDetector {
  constructor() {
    this.lastOperation = null;
    this.undoRedoDepth = 0;
  }

  /**
   * Monaco Editorの変更イベントから操作種別を推定
   * @param {Object} change - Monaco Editorのchange object
   * @param {Object} event - Monaco EditorのonDidChangeModelContent event
   * @returns {Object} - 詳細な操作情報
   */
  detectOperationType(change, event) {
    const { text, rangeLength, range } = change;
    const hasText = text && text.length > 0;
    const hasRangeLength = rangeLength > 0;

    let inputType = 'insertText';
    let operationDetail = {};

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
      inputType = this.detectInsertType(text, change);
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
    // Monaco Editorは直接的なUndo/Redo検出手段を提供しないため、
    // isUndoing/isRedoingフラグやstack depthで推定
    if (event.isUndoing) {
      inputType = 'historyUndo';
    } else if (event.isRedoing) {
      inputType = 'historyRedo';
    }

    // 5. 複数行の変更の検出
    const isMultiLine = this.isMultiLineChange(range);

    const result = {
      inputType,
      text: text || '',
      rangeOffset: change.rangeOffset,
      rangeLength: rangeLength,
      range: {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn
      },
      isMultiLine,
      ...operationDetail
    };

    this.lastOperation = result;
    return result;
  }

  /**
   * 削除操作の詳細な種別を推定
   */
  detectDeleteType(change, range) {
    const { rangeLength } = change;

    // 単一文字の削除
    if (rangeLength === 1) {
      // Backspace（カーソルより前を削除）
      if (range.startColumn > 1) {
        return 'deleteContentBackward';
      }
      // Delete（カーソル位置を削除）
      return 'deleteContentForward';
    }

    // 単語単位の削除（5文字以上で空白を含まない）
    if (rangeLength > 1 && rangeLength < 50) {
      return 'deleteWordBackward'; // または deleteWordForward
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
  detectInsertType(text, change) {
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
      // IME入力の可能性
      if (this.isLikelyIMEInput(text)) {
        return 'insertFromComposition';
      }

      // オートコンプリートや snippet
      return 'insertText'; // または insertReplacementText
    }

    return 'insertText';
  }

  /**
   * 削除方向を推定
   */
  getDeleteDirection(range) {
    // カーソルが行の先頭にある場合は forward、それ以外は backward
    if (range.startColumn === 1) {
      return 'forward';
    }
    return 'backward';
  }

  /**
   * 複数行の変更かどうか
   */
  isMultiLineChange(range) {
    return range.startLineNumber !== range.endLineNumber;
  }

  /**
   * IME入力の可能性を推定（日本語、中国語など）
   */
  isLikelyIMEInput(text) {
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
  isFormattingOperation(changes) {
    // 複数の変更が同時に発生した場合はフォーマット操作の可能性
    if (changes.length > 5) {
      return true;
    }

    // 全ての変更がインデント（空白/タブ）のみの場合
    const allIndentChanges = changes.every(change => {
      return /^[\s\t]*$/.test(change.text);
    });

    return allIndentChanges;
  }

  /**
   * 操作の詳細な説明を生成
   */
  getOperationDescription(operation) {
    const descriptions = {
      'insertText': '文字入力',
      'insertLineBreak': '改行',
      'insertParagraph': '段落挿入',
      'insertTab': 'タブ挿入',
      'insertFromComposition': 'IME入力',
      'deleteContentBackward': 'Backspace削除',
      'deleteContentForward': 'Delete削除',
      'deleteWordBackward': '単語削除（後方）',
      'deleteWordForward': '単語削除（前方）',
      'deleteHardLineBackward': '行削除',
      'deleteByCut': '範囲削除',
      'replaceContent': 'コンテンツ置換',
      'historyUndo': 'Undo',
      'historyRedo': 'Redo'
    };

    return descriptions[operation.inputType] || operation.inputType;
  }
}
