/**
 * VisibilityTracker - タブ可視性とウィンドウフォーカスの追跡
 * ブラウザタブの切り替えやウィンドウフォーカスを検知して記録
 */

import type { VisibilityChangeData, FocusChangeData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { BaseTracker } from './BaseTracker.js';

export interface VisibilityTrackerEvent {
  type: 'visibilityChange' | 'focusChange';
  data: VisibilityChangeData | FocusChangeData;
  description: string;
}

export type VisibilityTrackerCallback = (event: VisibilityTrackerEvent) => void | Promise<void>;

export class VisibilityTracker extends BaseTracker<VisibilityTrackerEvent, VisibilityTrackerCallback> {
  private boundHandleVisibilityChange: () => void;
  private boundHandleFocus: () => Promise<void>;
  private boundHandleBlur: () => void;
  private focusLostCallback: (() => void) | null = null;
  private focusRegainedCallback: (() => void) | null = null;

  constructor() {
    super();
    this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.boundHandleFocus = this.handleFocus.bind(this);
    this.boundHandleBlur = this.handleBlur.bind(this);
  }

  /**
   * フォーカス喪失時のコールバックを設定
   */
  setFocusLostCallback(callback: () => void): void {
    this.focusLostCallback = callback;
  }

  /**
   * フォーカス復帰時のコールバックを設定
   */
  setFocusRegainedCallback(callback: () => void): void {
    this.focusRegainedCallback = callback;
  }

  protected attachListeners(): void {
    document.addEventListener('visibilitychange', this.boundHandleVisibilityChange);
    window.addEventListener('focus', this.boundHandleFocus);
    window.addEventListener('blur', this.boundHandleBlur);
  }

  protected detachListeners(): void {
    document.removeEventListener('visibilitychange', this.boundHandleVisibilityChange);
    window.removeEventListener('focus', this.boundHandleFocus);
    window.removeEventListener('blur', this.boundHandleBlur);
  }

  /**
   * Visibility変更イベントハンドラ
   */
  private handleVisibilityChange(): void {
    const visibilityData: VisibilityChangeData = {
      visible: document.visibilityState === 'visible',
      visibilityState: document.visibilityState,
    };

    this.callback?.({
      type: 'visibilityChange',
      data: visibilityData,
      description: visibilityData.visible
        ? t('events.tabActive')
        : t('events.tabInactive'),
    });

    console.log('[TypedCode] Visibility changed:', visibilityData.visibilityState);
  }

  /**
   * フォーカス取得イベントハンドラ
   * イベント記録完了を待ってからfocusRegainedCallbackを呼び出す
   */
  private async handleFocus(): Promise<void> {
    const focusData: FocusChangeData = {
      focused: true,
    };

    // イベント記録の完了を待つ
    await this.callback?.({
      type: 'focusChange',
      data: focusData,
      description: t('events.windowFocused'),
    });

    // フォーカス復帰コールバックを呼び出し（イベント記録完了後）
    this.focusRegainedCallback?.();

    console.log('[TypedCode] Window focused');
  }

  /**
   * フォーカス喪失イベントハンドラ
   */
  private handleBlur(): void {
    const focusData: FocusChangeData = {
      focused: false,
    };

    this.callback?.({
      type: 'focusChange',
      data: focusData,
      description: t('events.windowBlurred'),
    });

    // フォーカス喪失コールバックを呼び出し
    this.focusLostCallback?.();

    console.log('[TypedCode] Window blurred');
  }

  override dispose(): void {
    super.dispose();
    this.focusLostCallback = null;
    this.focusRegainedCallback = null;
  }
}
