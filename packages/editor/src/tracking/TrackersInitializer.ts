/**
 * TrackersInitializer - トラッカーの初期化とコールバック設定
 *
 * 各種トラッカー（Window、Visibility、Keystroke、Mouse、Cursor、Editor）の
 * 初期化処理を集約し、main.tsの可読性を向上させる。
 */

import type { RecordEventInput } from '@typedcode/shared';
import type { AppContext } from '../core/AppContext.js';

/**
 * イベント記録用のコールバック
 */
export type RecordEventCallback = (event: RecordEventInput) => void;

/**
 * トラッカーのコールバック設定とアタッチを行う
 *
 * @param ctx - アプリケーションコンテキスト
 * @param editorContainer - エディタのDOM要素
 * @param recordEvent - イベント記録用コールバック
 * @param onProofStatusUpdate - 証明ステータス更新コールバック
 * @param onStorageSave - ストレージ保存コールバック
 */
export function initializeTrackers(
  ctx: AppContext,
  editorContainer: HTMLElement,
  recordEvent: RecordEventCallback,
  onProofStatusUpdate: () => void,
  onStorageSave: () => void
): void {
  const { trackers, editorController, editor } = ctx;

  // WindowTracker - ウィンドウサイズ変更の追跡
  trackers.window.setCallback((event) => {
    recordEvent({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.window.attach();
  trackers.window.recordInitial();

  // NetworkTracker - ネットワーク状態変更の追跡
  trackers.network.setCallback((event) => {
    recordEvent({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.network.attach();
  trackers.network.recordInitial();

  // VisibilityTracker - ページの表示/非表示の追跡
  trackers.visibility.setCallback((event) => {
    recordEvent({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.visibility.attach();

  // KeystrokeTracker - キーストロークの追跡
  trackers.keystroke.setCallback((event) => {
    recordEvent({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.keystroke.attach(editorContainer);

  // MouseTracker - マウス移動の追跡
  trackers.mouse.setCallback((event) => {
    recordEvent({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.mouse.attach(editorContainer);

  // CursorTracker - カーソル位置・選択範囲の追跡
  trackers.cursor.setCallback((event) => {
    if (event.type === 'cursorPositionChange') {
      recordEvent({
        type: event.type,
        data: event.data,
      });
    } else {
      recordEvent({
        type: event.type,
        data: event.data,
        range: event.range,
        rangeLength: event.rangeLength,
        selectedText: event.selectedText,
        description: event.description,
      });
    }
  });
  trackers.cursor.attach(editor);

  // EditorController - エディタコンテンツ変更の追跡
  editorController.setContentChangeCallback((event) => {
    recordEvent({
      type: event.type,
      inputType: event.inputType,
      data: event.data,
      rangeOffset: event.rangeOffset,
      rangeLength: event.rangeLength,
      range: event.range,
      isMultiLine: event.isMultiLine,
      description: event.description,
      ...(event.deletedLength && { deletedLength: event.deletedLength }),
      ...(event.insertedText && { insertedText: event.insertedText }),
      ...(event.insertLength && { insertLength: event.insertLength }),
      ...(event.deleteDirection && { deleteDirection: event.deleteDirection }),
    });
  });
  editorController.setAfterChangeCallback(() => {
    onProofStatusUpdate();
    onStorageSave();
  });
  editorController.attach(editor);
}
