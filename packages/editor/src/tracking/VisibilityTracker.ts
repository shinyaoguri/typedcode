/**
 * VisibilityTracker - タブ可視性とウィンドウフォーカスの追跡
 * ブラウザタブの切り替えやウィンドウフォーカスを検知して記録
 */

import type { VisibilityChangeData, FocusChangeData } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export interface VisibilityTrackerEvent {
  type: 'visibilityChange' | 'focusChange';
  data: VisibilityChangeData | FocusChangeData;
  description: string;
}

export type VisibilityTrackerCallback = (event: VisibilityTrackerEvent) => void;

export class VisibilityTracker {
  private callback: VisibilityTrackerCallback | null = null;
  private boundHandleVisibilityChange: () => void;
  private boundHandleFocus: () => void;
  private boundHandleBlur: () => void;
  private attached = false;

  constructor() {
    this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.boundHandleFocus = this.handleFocus.bind(this);
    this.boundHandleBlur = this.handleBlur.bind(this);
  }

  /**
   * コールバックを設定
   */
  setCallback(callback: VisibilityTrackerCallback): void {
    this.callback = callback;
  }

  /**
   * イベントリスナーをアタッチ
   */
  attach(): void {
    if (this.attached) return;

    document.addEventListener('visibilitychange', this.boundHandleVisibilityChange);
    window.addEventListener('focus', this.boundHandleFocus);
    window.addEventListener('blur', this.boundHandleBlur);

    this.attached = true;
  }

  /**
   * イベントリスナーをデタッチ
   */
  detach(): void {
    if (!this.attached) return;

    document.removeEventListener('visibilitychange', this.boundHandleVisibilityChange);
    window.removeEventListener('focus', this.boundHandleFocus);
    window.removeEventListener('blur', this.boundHandleBlur);

    this.attached = false;
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
   */
  private handleFocus(): void {
    const focusData: FocusChangeData = {
      focused: true,
    };

    this.callback?.({
      type: 'focusChange',
      data: focusData,
      description: t('events.windowFocused'),
    });

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

    console.log('[TypedCode] Window blurred');
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.callback = null;
  }
}
