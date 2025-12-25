/**
 * InputDetector - コピペやドラッグ&ドロップなどの外部入力を検出
 * ブロックはせず、検出して通知・記録する
 */

export class InputDetector {
  constructor(domElement, onDetectedAction) {
    this.element = domElement;
    this.onDetectedAction = onDetectedAction || (() => {});
    this.setupDetectors();
  }

  /**
   * 全ての検出器を設定
   */
  setupDetectors() {
    // paste イベントを検出
    this.element.addEventListener('paste', (e) => {
      const clipboardData = e.clipboardData || window.clipboardData;
      const pastedText = clipboardData.getData('text');

      this.notifyDetected('paste', 'コピー&ペーストを検出しました', {
        text: pastedText,
        length: pastedText.length
      });
    }, true);

    // drop イベントを検出
    this.element.addEventListener('drop', (e) => {
      const droppedText = e.dataTransfer.getData('text');

      this.notifyDetected('drop', 'ドラッグ&ドロップを検出しました', {
        text: droppedText,
        length: droppedText.length
      });
    }, true);

    // copy イベント（読み取り専用なので記録のみ）
    this.element.addEventListener('copy', (e) => {
      const selection = window.getSelection();
      const copiedText = selection.toString();

      console.log('[InputDetector] Copy detected:', copiedText.substring(0, 50));
    }, true);
  }

  /**
   * 検出されたことを通知
   */
  notifyDetected(eventType, message, data) {
    console.log(`[InputDetector] Detected: ${eventType} - ${message}`, data);
    this.onDetectedAction({
      type: eventType,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 検出器を削除
   */
  destroy() {
    this.element = null;
  }
}
