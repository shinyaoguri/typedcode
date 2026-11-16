/**
 * EditorController - エディタコンテンツ変更の追跡
 * Monacoエディタのコンテンツ変更イベントを検知して記録
 */

import type * as monaco from 'monaco-editor';
import type { InputType } from '@typedcode/shared';
import type { OperationDetector } from '../tracking/OperationDetector.js';
import type { CompositionTracker } from '../tracking/CompositionTracker.js';

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
  /**
   * 編集を IME の composition に対応付ける (#720)。無ければどの編集も composition に帰属させない
   * (composition 系の inputType を出さない)。
   */
  compositionTracker?: CompositionTracker;
  onContentChange?: ContentChangeCallback;
  onAfterChange?: () => void;
  debug?: boolean;
}

export class EditorController {
  private operationDetector: OperationDetector;
  private compositionTracker: CompositionTracker | null;
  private onContentChange: ContentChangeCallback | null;
  private onAfterChange: (() => void) | null;
  private debug: boolean;
  private disposables: monaco.IDisposable[] = [];
  private attached = false;

  constructor(options: EditorControllerOptions) {
    this.operationDetector = options.operationDetector;
    this.compositionTracker = options.compositionTracker ?? null;
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

    // 内容変更の購読より先に付ける (同じ editor の composition を start から追う)
    this.compositionTracker?.attach(editor);
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
    // 外している間の composition を引き継がない (付け直したら idle から)
    this.compositionTracker?.detach();
    this.attached = false;
  }

  /**
   * コンテンツ変更ハンドラ
   */
  private handleContentChange(e: monaco.editor.IModelContentChangedEvent): void {
    for (const change of e.changes) {
      // 記録と同じ順に 1 件ずつ同期で帰属を決める (前の change が composition の領域を動かす)
      const attribution = this.compositionTracker?.attribute(change, e) ?? 'none';
      const operation = this.operationDetector.detectOperationType(change, e, attribution);
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
