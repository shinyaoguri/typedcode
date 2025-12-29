/**
 * InputDetector - コピペやドラッグ&ドロップなどの外部入力を検出
 * ブロックはせず、検出して通知・記録する
 */

import type {
  DetectedEvent,
  DetectedEventType,
  DetectedEventData,
  OnDetectedCallback,
} from '@typedcode/shared';
import { t } from '../i18n/index.js';

export class InputDetector {
  private element: HTMLElement | null;
  private onDetectedAction: OnDetectedCallback;

  constructor(domElement: HTMLElement, onDetectedAction?: OnDetectedCallback) {
    this.element = domElement;
    this.onDetectedAction = onDetectedAction ?? (() => {});
    this.setupDetectors();
  }

  /**
   * 全ての検出器を設定
   */
  private setupDetectors(): void {
    if (!this.element) return;

    // paste イベントを検出
    this.element.addEventListener('paste', (e: ClipboardEvent) => {
      const clipboardData = e.clipboardData ?? window.clipboardData;
      const pastedText = clipboardData?.getData('text') ?? '';

      this.notifyDetected('paste', t('events.paste', { length: String(pastedText.length) }), {
        text: pastedText,
        length: pastedText.length
      });
    }, true);

    // drop イベントを検出
    this.element.addEventListener('drop', (e: DragEvent) => {
      const droppedText = e.dataTransfer?.getData('text') ?? '';

      this.notifyDetected('drop', t('events.drop', { length: String(droppedText.length) }), {
        text: droppedText,
        length: droppedText.length
      });
    }, true);

    // copy イベント（読み取り専用なので記録のみ）
    this.element.addEventListener('copy', () => {
      const selection = window.getSelection();
      const copiedText = selection?.toString() ?? '';

      console.log('[InputDetector] Copy detected:', copiedText.substring(0, 50));
    }, true);
  }

  /**
   * 検出されたことを通知
   */
  private notifyDetected(eventType: DetectedEventType, message: string, data: DetectedEventData): void {
    console.log(`[InputDetector] Detected: ${eventType} - ${message}`, data);

    const event: DetectedEvent = {
      type: eventType,
      message,
      data,
      timestamp: Date.now()
    };

    this.onDetectedAction(event);
  }

  /**
   * 検出器を削除
   */
  destroy(): void {
    this.element = null;
  }
}
