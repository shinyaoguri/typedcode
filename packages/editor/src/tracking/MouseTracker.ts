/**
 * Mouse Position Tracker
 *
 * Tracks mouse movement within an element with throttling.
 */

import type { MousePositionData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { ElementTracker } from './BaseTracker.js';

export interface MouseEvent {
  type: 'mousePositionChange';
  data: MousePositionData;
  description: string;
}

export type MouseEventCallback = (event: MouseEvent) => void;

export interface MouseTrackerOptions {
  /** Throttle interval in ms (default: 100) */
  throttleMs?: number;
}

export class MouseTracker extends ElementTracker<MouseEvent, MouseEventCallback> {
  private lastPosition: MousePositionData | null = null;
  private lastTime: number = 0;
  private throttleMs: number;

  // バインドされたハンドラー（detach時に必要）
  private boundHandleMouseMove: (e: globalThis.MouseEvent) => void;

  constructor(options: MouseTrackerOptions = {}) {
    super();
    this.throttleMs = options.throttleMs ?? 100;
    this.boundHandleMouseMove = this.handleMouseMove.bind(this);
  }

  /**
   * Handle a mousemove event
   */
  handleMouseMove(e: globalThis.MouseEvent): void {
    if (!this.enabled || !this.callback) return;

    const currentTime = performance.now();

    // Throttle events
    if (currentTime - this.lastTime < this.throttleMs) {
      return;
    }

    const mouseData: MousePositionData = {
      x: e.offsetX,
      y: e.offsetY,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };

    // Skip if position hasn't changed
    if (
      this.lastPosition &&
      this.lastPosition.x === mouseData.x &&
      this.lastPosition.y === mouseData.y
    ) {
      return;
    }

    this.lastPosition = mouseData;
    this.lastTime = currentTime;

    this.emit({
      type: 'mousePositionChange',
      data: mouseData,
      description: t('events.mousePosition', { x: String(mouseData.x), y: String(mouseData.y) }),
    });
  }

  /**
   * Attach event listeners to an element (後方互換性のため維持)
   */
  attach(element?: HTMLElement): void {
    if (element) {
      this.attachTo(element);
    } else {
      super.attach();
    }
  }

  /**
   * Reset tracking state
   */
  override reset(): void {
    this.lastPosition = null;
    this.lastTime = 0;
  }

  protected attachListeners(): void {
    if (!this.element) return;
    this.element.addEventListener('mousemove', this.boundHandleMouseMove);
  }

  protected detachListeners(): void {
    if (!this.element) return;
    this.element.removeEventListener('mousemove', this.boundHandleMouseMove);
  }
}
