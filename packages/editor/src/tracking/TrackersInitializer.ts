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
 * トラッカー初期化オプション
 */
export interface TrackersInitializerOptions {
  ctx: AppContext;
  editorContainer: HTMLElement;
  recordEvent: RecordEventCallback;
  /** 全タブにイベントを記録するコールバック（スクリーンショット等セッション共通イベント用） */
  recordEventToAllTabs: RecordEventCallback;
  onProofStatusUpdate: () => void;
  onStorageSave: () => void;
}

/**
 * トラッカーのコールバック設定とアタッチを行う
 *
 * @param options - 初期化オプション
 */
export function initializeTrackers(options: TrackersInitializerOptions): void {
  const {
    ctx,
    editorContainer,
    recordEvent,
    recordEventToAllTabs,
    onProofStatusUpdate,
    onStorageSave,
  } = options;
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

  // ScreenshotTrackerとの連携（フォーカス喪失/復帰時のキャプチャ）
  if (trackers.screenshot) {
    trackers.visibility.setFocusLostCallback(() => {
      trackers.screenshot?.notifyFocusLost();
    });
    trackers.visibility.setFocusRegainedCallback(() => {
      trackers.screenshot?.notifyFocusRegained();
    });
  }

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

  // ScreenshotTracker - スクリーンショットの追跡
  // スクリーンショット関連イベントはセッション全体に関わるため、全タブに記録
  if (trackers.screenshot) {
    trackers.screenshot.setCallback((event) => {
      recordEventToAllTabs({
        type: event.type,
        data: event.data,
        description: event.description,
      });
    });
  }
}
