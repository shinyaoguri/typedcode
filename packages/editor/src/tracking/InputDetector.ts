/**
 * InputDetector - コピペやドラッグ&ドロップなどの外部入力を検出
 * ブロックはせず、検出して通知・記録する
 */

import type { DetectedEvent, DetectedEventType, DetectedEventData, OnDetectedCallback } from '@typedcode/shared';
import { t } from '../i18n/index.js';

/** 検出するイベントの種類 (既定は全部) */
export type InputDetectorEventType = 'paste' | 'drop' | 'copy';

const ALL_EVENT_TYPES: readonly InputDetectorEventType[] = ['paste', 'drop', 'copy'];

export class InputDetector {
  private element: HTMLElement | null;
  private onDetectedAction: OnDetectedCallback;
  private readonly eventTypes: readonly InputDetectorEventType[];

  /**
   * @param domElement - capture で聞く要素。この要素の中が target のイベントだけを拾う
   * @param eventTypes - 拾うイベントの種類 (要素ごとに範囲を分けるときに絞る)
   */
  constructor(
    domElement: HTMLElement,
    onDetectedAction?: OnDetectedCallback,
    eventTypes: readonly InputDetectorEventType[] = ALL_EVENT_TYPES
  ) {
    this.element = domElement;
    this.onDetectedAction = onDetectedAction ?? (() => {});
    this.eventTypes = eventTypes;
    this.setupDetectors();
  }

  /**
   * 全ての検出器を設定
   */
  private setupDetectors(): void {
    if (!this.element) return;

    // paste イベントを検出
    if (this.eventTypes.includes('paste')) {
      this.element.addEventListener(
        'paste',
        (e: ClipboardEvent) => {
          const clipboardData = e.clipboardData ?? window.clipboardData;
          const pastedText = clipboardData?.getData('text') ?? '';

          this.notifyDetected('paste', t('events.paste', { length: String(pastedText.length) }), {
            text: pastedText,
            length: pastedText.length,
          });
        },
        true
      );
    }

    // drop イベントを検出
    if (this.eventTypes.includes('drop')) {
      this.element.addEventListener(
        'drop',
        (e: DragEvent) => {
          const droppedText = e.dataTransfer?.getData('text') ?? '';

          this.notifyDetected('drop', t('events.drop', { length: String(droppedText.length) }), {
            text: droppedText,
            length: droppedText.length,
          });
        },
        true
      );
    }

    // copy イベント（監査用に記録）
    if (this.eventTypes.includes('copy')) {
      this.element.addEventListener(
        'copy',
        () => {
          const selection = window.getSelection();
          const copiedText = selection?.toString() ?? '';

          this.notifyDetected('copy', t('events.copy', { length: String(copiedText.length) }), {
            text: copiedText,
            length: copiedText.length,
          });
        },
        true
      );
    }
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
      timestamp: Date.now(),
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
