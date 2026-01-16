/**
 * Keystroke Dynamics Tracker
 *
 * Tracks keystroke timing information for behavioral biometrics.
 * Measures:
 * - Flight Time: Time between releasing one key and pressing the next
 * - Dwell Time: Time a key is held down
 */

import type { KeystrokeDynamicsData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { ElementTracker } from './BaseTracker.js';

export interface KeystrokeThresholds {
  /** Maximum valid flight time in ms (default: 2000) */
  maxFlightTime: number;
  /** Maximum valid dwell time in ms (default: 1000) */
  maxDwellTime: number;
  /** Minimum valid dwell time in ms (default: 5) */
  minDwellTime: number;
  /** Minimum valid flight time in ms (default: 0) */
  minFlightTime: number;
}

export interface KeystrokeEvent {
  type: 'keyDown' | 'keyUp';
  data: KeystrokeDynamicsData;
  description: string;
}

export type KeystrokeEventCallback = (event: KeystrokeEvent) => void;

const DEFAULT_THRESHOLDS: KeystrokeThresholds = {
  maxFlightTime: 2000,
  maxDwellTime: 1000,
  minDwellTime: 5,
  minFlightTime: 0,
};

export class KeystrokeTracker extends ElementTracker<KeystrokeEvent, KeystrokeEventCallback> {
  private keyDownTimes: Map<string, number> = new Map();
  private lastKeyUpTime: number = 0;
  private thresholds: KeystrokeThresholds;

  // バインドされたハンドラー（detach時に必要）
  private boundHandleKeyDown: (e: KeyboardEvent) => void;
  private boundHandleKeyUp: (e: KeyboardEvent) => void;

  constructor(thresholds?: Partial<KeystrokeThresholds>) {
    super();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleKeyUp = this.handleKeyUp.bind(this);
  }

  /**
   * Handle a keydown event
   */
  handleKeyDown(e: KeyboardEvent): void {
    if (!this.enabled || !this.callback) return;

    const currentTime = performance.now();
    const code = e.code;

    // Skip if key is already pressed (key repeat)
    if (this.keyDownTimes.has(code)) {
      return;
    }

    // Record keyDown time
    this.keyDownTimes.set(code, currentTime);

    // Calculate flight time (time since last keyUp)
    let flightTime: number | undefined;
    if (this.lastKeyUpTime > 0) {
      const rawFlightTime = currentTime - this.lastKeyUpTime;
      if (rawFlightTime <= this.thresholds.maxFlightTime) {
        flightTime = Math.max(this.thresholds.minFlightTime, rawFlightTime);
      }
    }

    const keystrokeData: KeystrokeDynamicsData = {
      key: e.key,
      code: code,
      keyDownTime: currentTime,
      flightTime: flightTime,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    };

    const modifierStr = this.getModifierString(e);
    this.emit({
      type: 'keyDown',
      data: keystrokeData,
      description: t('events.keyDown', { key: `${e.key}${modifierStr}` }),
    });
  }

  /**
   * Handle a keyup event
   */
  handleKeyUp(e: KeyboardEvent): void {
    if (!this.enabled || !this.callback) return;

    const currentTime = performance.now();
    const code = e.code;

    // Calculate dwell time (time key was held)
    const keyDownTime = this.keyDownTimes.get(code);
    let dwellTime: number | undefined;
    if (keyDownTime !== undefined) {
      const rawDwellTime = currentTime - keyDownTime;
      if (
        rawDwellTime >= this.thresholds.minDwellTime &&
        rawDwellTime <= this.thresholds.maxDwellTime
      ) {
        dwellTime = rawDwellTime;
      }
    }

    // Clear keyDown time
    this.keyDownTimes.delete(code);

    // Update lastKeyUpTime for next flight time calculation
    this.lastKeyUpTime = currentTime;

    const keystrokeData: KeystrokeDynamicsData = {
      key: e.key,
      code: code,
      dwellTime: dwellTime,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    };

    const dwellStr = dwellTime !== undefined ? ` (${t('events.dwellTime', { time: dwellTime.toFixed(0) })})` : '';
    this.emit({
      type: 'keyUp',
      data: keystrokeData,
      description: t('events.keyUp', { key: `${e.key}${dwellStr}` }),
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
    this.keyDownTimes.clear();
    this.lastKeyUpTime = 0;
  }

  protected attachListeners(): void {
    if (!this.element) return;
    this.element.addEventListener('keydown', this.boundHandleKeyDown, { capture: true });
    this.element.addEventListener('keyup', this.boundHandleKeyUp, { capture: true });
  }

  protected detachListeners(): void {
    if (!this.element) return;
    this.element.removeEventListener('keydown', this.boundHandleKeyDown, { capture: true });
    this.element.removeEventListener('keyup', this.boundHandleKeyUp, { capture: true });
  }

  private getModifierString(e: KeyboardEvent): string {
    const modifiers: string[] = [];
    if (e.shiftKey) modifiers.push('Shift');
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.metaKey) modifiers.push('Meta');
    return modifiers.length > 0 ? ` (${modifiers.join('+')})` : '';
  }
}
