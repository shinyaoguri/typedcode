/**
 * Mouse Position Tracker
 *
 * Tracks mouse movement within an element with throttling.
 */

import type { MousePositionData } from '@typedcode/shared';

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

export class MouseTracker {
  private lastPosition: MousePositionData | null = null;
  private lastTime: number = 0;
  private throttleMs: number;
  private enabled: boolean = true;
  private callback: MouseEventCallback | null = null;

  constructor(options: MouseTrackerOptions = {}) {
    this.throttleMs = options.throttleMs ?? 100;
  }

  /**
   * Set the callback for mouse events
   */
  setCallback(callback: MouseEventCallback): void {
    this.callback = callback;
  }

  /**
   * Enable or disable tracking
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if tracking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
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

    this.callback({
      type: 'mousePositionChange',
      data: mouseData,
      description: `マウス位置: (${mouseData.x}, ${mouseData.y})`,
    });
  }

  /**
   * Attach event listeners to an element
   */
  attach(element: HTMLElement): void {
    element.addEventListener('mousemove', this.handleMouseMove.bind(this));
  }

  /**
   * Reset tracking state
   */
  reset(): void {
    this.lastPosition = null;
    this.lastTime = 0;
  }
}
