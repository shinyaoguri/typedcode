/**
 * WindowTracker - ウィンドウサイズ変更の追跡
 * リサイズイベントをデバウンスして記録
 */

import type { WindowSizeData } from '@typedcode/shared';

export interface WindowTrackerEvent {
  type: 'windowResize';
  data: WindowSizeData;
  description: string;
}

export type WindowTrackerCallback = (event: WindowTrackerEvent, isInitial: boolean) => void;

const WINDOW_RESIZE_DEBOUNCE_MS = 500;

export class WindowTracker {
  private lastWindowSize: WindowSizeData | null = null;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private callback: WindowTrackerCallback | null = null;
  private boundHandleResize: () => void;
  private attached = false;

  constructor() {
    this.boundHandleResize = this.handleResize.bind(this);
  }

  /**
   * コールバックを設定
   */
  setCallback(callback: WindowTrackerCallback): void {
    this.callback = callback;
  }

  /**
   * ウィンドウイベントリスナーをアタッチ
   */
  attach(): void {
    if (this.attached) return;
    window.addEventListener('resize', this.boundHandleResize);
    this.attached = true;
  }

  /**
   * ウィンドウイベントリスナーをデタッチ
   */
  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('resize', this.boundHandleResize);
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }
    this.attached = false;
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
      description: `初期ウィンドウサイズ: ${currentSize.innerWidth}x${currentSize.innerHeight}`,
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
        description: `ウィンドウリサイズ: ${currentSize.innerWidth}x${currentSize.innerHeight}`,
      }, false);
    }, WINDOW_RESIZE_DEBOUNCE_MS);
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.callback = null;
    this.lastWindowSize = null;
  }
}
