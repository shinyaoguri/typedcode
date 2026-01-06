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
 * 全タブへのイベント記録用コールバック（Promise返却）
 */
export type RecordEventToAllTabsCallback = (event: RecordEventInput) => Promise<void>;

/**
 * トラッカー初期化オプション
 */
export interface TrackersInitializerOptions {
  ctx: AppContext;
  editorContainer: HTMLElement;
  recordEvent: RecordEventCallback;
  /** 全タブにイベントを記録するコールバック（スクリーンショット等セッション共通イベント用） */
  recordEventToAllTabs: RecordEventToAllTabsCallback;
  onProofStatusUpdate: () => void;
  onStorageSave: () => void;
  /** フォーカス復帰時のコールバック（LogViewer更新等） */
  onFocusRegained?: () => void;
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
    onFocusRegained,
  } = options;
  const { trackers, editorController, editor } = ctx;

  // WindowTracker - ウィンドウサイズ変更の追跡
  // ウィンドウサイズ変更はセッション全体に影響するため、全タブに記録
  trackers.window.setCallback((event) => {
    recordEventToAllTabs({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.window.attach();
  trackers.window.recordInitial();

  // NetworkTracker - ネットワーク状態変更の追跡
  // ネットワーク状態変更はセッション全体に影響するため、全タブに記録
  trackers.network.setCallback((event) => {
    recordEventToAllTabs({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  trackers.network.attach();
  trackers.network.recordInitial();

  // VisibilityTracker - ページの表示/非表示の追跡
  // タブの可視性やフォーカス状態はセッション全体に影響するため、全タブに記録
  trackers.visibility.setCallback((event) => {
    recordEventToAllTabs({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });

  // ScreenshotTrackerおよびIdleTimeoutManagerとの連携
  trackers.visibility.setFocusLostCallback(() => {
    // スクリーンショット撮影通知
    trackers.screenshot?.notifyFocusLost();
    // アイドルタイムアウト監視開始
    ctx.idleTimeoutManager?.handleFocusLost();
  });
  trackers.visibility.setFocusRegainedCallback(() => {
    // スクリーンショット撮影通知
    trackers.screenshot?.notifyFocusRegained();
    // アイドルタイムアウトタイマーリセット
    ctx.idleTimeoutManager?.handleFocusRegained();
    // LogViewer更新等のコールバック
    onFocusRegained?.();
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

  // ScreenshotTracker - スクリーンショットの追跡
  // スクリーンショット関連イベントはセッション全体に関わるため、全タブに記録
  console.debug(`[TrackersInitializer] trackers.screenshot is ${trackers.screenshot ? 'set' : 'null'}`);
  if (trackers.screenshot) {
    // TypingProofのstartTimeを設定（タイムスタンプをハッシュチェーンと同期させるため）
    const activeProof = ctx.tabManager?.getActiveProof();
    if (activeProof) {
      trackers.screenshot.setProofStartTime(activeProof.startTime);
    }

    console.debug('[TrackersInitializer] Setting screenshot callback');
    trackers.screenshot.setCallback((event) => {
      console.debug(`[TrackersInitializer] Screenshot callback called: ${event.type}`);
      recordEventToAllTabs({
        type: event.type,
        data: event.data,
        description: event.description,
      });
    });
  }
}
