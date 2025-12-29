/**
 * CursorTracker - カーソル位置と選択範囲の追跡
 * エディタのカーソル移動と選択変更を検知して記録
 */

import type * as monaco from 'monaco-editor';
import { t } from '../i18n/index.js';

export interface CursorPosition {
  lineNumber: number;
  column: number;
}

export interface SelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface CursorChangeEvent {
  type: 'cursorPositionChange';
  data: CursorPosition;
}

export interface SelectionChangeEvent {
  type: 'selectionChange';
  data: SelectionRange;
  range: SelectionRange;
  rangeLength: number;
  selectedText: string | null;
  description: string;
}

export type CursorTrackerEvent = CursorChangeEvent | SelectionChangeEvent;
export type CursorTrackerCallback = (event: CursorTrackerEvent) => void;
export type CursorPositionUpdateCallback = (lineNumber: number, column: number) => void;

export interface CursorTrackerOptions {
  /** デバウンス間隔（ミリ秒） */
  debounceMs?: number;
  /** カーソル位置更新時のコールバック（ステータスバー用、デバウンスなし） */
  onCursorPositionUpdate?: CursorPositionUpdateCallback;
}

const DEFAULT_DEBOUNCE_MS = 50;

export class CursorTracker {
  private callback: CursorTrackerCallback | null = null;
  private onCursorPositionUpdate: CursorPositionUpdateCallback | null = null;
  private debounceMs: number;
  private lastCursorPosition: string | null = null;
  private lastCursorTime = 0;
  private lastSelectionRange: string | null = null;
  private lastSelectionTime = 0;
  private disposables: monaco.IDisposable[] = [];
  private attached = false;

  constructor(options: CursorTrackerOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onCursorPositionUpdate = options.onCursorPositionUpdate ?? null;
  }

  /**
   * コールバックを設定
   */
  setCallback(callback: CursorTrackerCallback): void {
    this.callback = callback;
  }

  /**
   * エディタにイベントリスナーをアタッチ
   */
  attach(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (this.attached) return;

    // カーソル位置変更イベント
    const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
      this.handleCursorPositionChange(e);
    });
    this.disposables.push(cursorDisposable);

    // 選択範囲変更イベント
    const selectionDisposable = editor.onDidChangeCursorSelection((e) => {
      this.handleSelectionChange(e, editor);
    });
    this.disposables.push(selectionDisposable);

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
   * カーソル位置変更ハンドラ
   */
  private handleCursorPositionChange(
    e: monaco.editor.ICursorPositionChangedEvent
  ): void {
    // ステータスバー更新は常に実行（デバウンスなし）
    this.onCursorPositionUpdate?.(e.position.lineNumber, e.position.column);

    const currentPos = `${e.position.lineNumber}:${e.position.column}`;
    const currentTime = performance.now();

    // デバウンス：同じ位置への連続イベントをスキップ
    if (
      this.lastCursorPosition === currentPos &&
      currentTime - this.lastCursorTime < this.debounceMs
    ) {
      return;
    }

    this.lastCursorPosition = currentPos;
    this.lastCursorTime = currentTime;

    this.callback?.({
      type: 'cursorPositionChange',
      data: {
        lineNumber: e.position.lineNumber,
        column: e.position.column,
      },
    });
  }

  /**
   * 選択範囲変更ハンドラ
   */
  private handleSelectionChange(
    e: monaco.editor.ICursorSelectionChangedEvent,
    editor: monaco.editor.IStandaloneCodeEditor
  ): void {
    const currentRange = `${e.selection.startLineNumber}:${e.selection.startColumn}-${e.selection.endLineNumber}:${e.selection.endColumn}`;
    const currentTime = performance.now();

    // デバウンス：同じ範囲への連続イベントをスキップ
    if (
      this.lastSelectionRange === currentRange &&
      currentTime - this.lastSelectionTime < this.debounceMs
    ) {
      return;
    }

    this.lastSelectionRange = currentRange;
    this.lastSelectionTime = currentTime;

    const model = editor.getModel();
    const selectedText = model?.getValueInRange(e.selection) ?? '';
    const selectionLength = selectedText.length;

    const isEmpty =
      e.selection.startLineNumber === e.selection.endLineNumber &&
      e.selection.startColumn === e.selection.endColumn;

    const range: SelectionRange = {
      startLineNumber: e.selection.startLineNumber,
      startColumn: e.selection.startColumn,
      endLineNumber: e.selection.endLineNumber,
      endColumn: e.selection.endColumn,
    };

    this.callback?.({
      type: 'selectionChange',
      data: range,
      range,
      rangeLength: selectionLength,
      selectedText: isEmpty ? null : selectedText,
      description: isEmpty ? t('events.selectionClear') : t('events.selectionCount', { count: String(selectionLength) }),
    });
  }

  /**
   * 状態をリセット
   */
  reset(): void {
    this.lastCursorPosition = null;
    this.lastCursorTime = 0;
    this.lastSelectionRange = null;
    this.lastSelectionTime = 0;
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.callback = null;
  }
}
