/**
 * WindowTracker - ウィンドウサイズ変更の追跡
 * リサイズイベントをデバウンスして記録
 */

import type { WindowSizeData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { BaseTracker } from './BaseTracker.js';

export interface WindowTrackerEvent {
  type: 'windowResize';
  data: WindowSizeData;
  description: string;
}

export type WindowTrackerCallback = (event: WindowTrackerEvent, isInitial: boolean) => void;

const WINDOW_RESIZE_DEBOUNCE_MS = 500;

export class WindowTracker extends BaseTracker<WindowTrackerEvent, WindowTrackerCallback> {
  private lastWindowSize: WindowSizeData | null = null;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private boundHandleResize: () => void;

  constructor() {
    super();
    this.boundHandleResize = this.handleResize.bind(this);
  }

  protected attachListeners(): void {
    window.addEventListener('resize', this.boundHandleResize);
  }

  protected detachListeners(): void {
    window.removeEventListener('resize', this.boundHandleResize);
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }
  }

  /**
   * 初期ウィンドウサイズを記録
   */
  recordInitial(): void {
    const currentSize = this.getCurrentWindowSize();
    this.lastWindowSize = currentSize;

    this.callback?.({
      type: 'windowResize',
      data: currentSize,
      description: t('events.initialWindowSize', { width: String(currentSize.innerWidth), height: String(currentSize.innerHeight) }),
    }, true);
  }

  /**
   * 現在のウィンドウサイズを取得
   */
  private getCurrentWindowSize(): WindowSizeData {
    return {
      width: window.outerWidth,
      height: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenX: window.screenX,
      screenY: window.screenY,
    };
  }

  /**
   * ウィンドウサイズが変更されたかチェック
   */
  private hasWindowSizeChanged(current: WindowSizeData, previous: WindowSizeData | null): boolean {
    if (!previous) return true;
    return (
      current.width !== previous.width ||
      current.height !== previous.height ||
      current.innerWidth !== previous.innerWidth ||
      current.innerHeight !== previous.innerHeight ||
      current.devicePixelRatio !== previous.devicePixelRatio ||
      current.screenX !== previous.screenX ||
      current.screenY !== previous.screenY
    );
  }

  /**
   * リサイズイベントハンドラ（デバウンス付き）
   */
  private handleResize(): void {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }

    this.resizeTimeout = setTimeout(() => {
      const currentSize = this.getCurrentWindowSize();

      if (!this.hasWindowSizeChanged(currentSize, this.lastWindowSize)) {
        return;
      }

      this.lastWindowSize = currentSize;

      this.callback?.({
        type: 'windowResize',
        data: currentSize,
        description: t('events.windowResize', { width: String(currentSize.innerWidth), height: String(currentSize.innerHeight) }),
      }, false);
    }, WINDOW_RESIZE_DEBOUNCE_MS);
  }

  override dispose(): void {
    super.dispose();
    this.lastWindowSize = null;
  }
}
