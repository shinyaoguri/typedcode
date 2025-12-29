/**
 * EditorController - エディタコンテンツ変更の追跡
 * Monacoエディタのコンテンツ変更イベントを検知して記録
 */

import type * as monaco from 'monaco-editor';
import type { InputType } from '@typedcode/shared';
import type { OperationDetector } from '../tracking/OperationDetector.js';

export interface ContentChangeEvent {
  type: 'contentChange';
  inputType: InputType;
  data: string;
  rangeOffset: number;
  rangeLength: number;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  isMultiLine: boolean;
  description: string;
  deletedLength?: number;
  insertedText?: string;
  insertLength?: number;
  deleteDirection?: 'forward' | 'backward';
}

export type ContentChangeCallback = (event: ContentChangeEvent) => void;

export interface EditorControllerOptions {
  operationDetector: OperationDetector;
  onContentChange?: ContentChangeCallback;
  onAfterChange?: () => void;
  debug?: boolean;
}

export class EditorController {
  private operationDetector: OperationDetector;
  private onContentChange: ContentChangeCallback | null;
  private onAfterChange: (() => void) | null;
  private debug: boolean;
  private disposables: monaco.IDisposable[] = [];
  private attached = false;

  constructor(options: EditorControllerOptions) {
    this.operationDetector = options.operationDetector;
    this.onContentChange = options.onContentChange ?? null;
    this.onAfterChange = options.onAfterChange ?? null;
    this.debug = options.debug ?? false;
  }

  /**
   * コンテンツ変更コールバックを設定
   */
  setContentChangeCallback(callback: ContentChangeCallback): void {
    this.onContentChange = callback;
  }

  /**
   * 変更後コールバックを設定
   */
  setAfterChangeCallback(callback: () => void): void {
    this.onAfterChange = callback;
  }

  /**
   * エディタにイベントリスナーをアタッチ
   */
  attach(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (this.attached) return;

    const disposable = editor.onDidChangeModelContent((e) => {
      this.handleContentChange(e);
    });
    this.disposables.push(disposable);

    this.attached = true;
  }

  /**
   * イベントリスナーをデタッチ
   */
  detach(): void {
    if (!this.attached) return;

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.attached = false;
  }

  /**
   * コンテンツ変更ハンドラ
   */
  private handleContentChange(e: monaco.editor.IModelContentChangedEvent): void {
    for (const change of e.changes) {
      const operation = this.operationDetector.detectOperationType(change, e);
      const description = this.operationDetector.getOperationDescription(operation);

      const event: ContentChangeEvent = {
        type: 'contentChange',
        inputType: operation.inputType,
        data: operation.text,
        rangeOffset: operation.rangeOffset,
        rangeLength: operation.rangeLength,
        range: operation.range,
        isMultiLine: operation.isMultiLine,
        description,
        ...(operation.deletedLength && { deletedLength: operation.deletedLength }),
        ...(operation.insertedText && { insertedText: operation.insertedText }),
        ...(operation.insertLength && { insertLength: operation.insertLength }),
        ...(operation.deleteDirection && { deleteDirection: operation.deleteDirection }),
      };

      this.onContentChange?.(event);

      if (this.debug) {
        console.log('[EditorController] Operation detected:', {
          type: operation.inputType,
          description,
          text: operation.text.substring(0, 20) + (operation.text.length > 20 ? '...' : ''),
        });
      }
    }

    // 変更後の処理（ステータス更新など）
    this.onAfterChange?.();
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.onContentChange = null;
    this.onAfterChange = null;
  }
}
