/**
 * ScreenShareGuide - 画面共有ダイアログの非表示ボタンを押すよう促すガイド
 * Chromeの「画面を共有しています」ダイアログの位置を指し示し、
 * ユーザーに「非表示」ボタンを押すよう案内する
 */

import { t } from '../../i18n/index.js';

/** ガイドの自動非表示までの時間（ミリ秒） */
const AUTO_HIDE_DELAY_MS = 8000;

export class ScreenShareGuide {
  private element: HTMLElement | null = null;
  private autoHideTimer: number | null = null;

  /**
   * ガイドを表示
   */
  show(): void {
    // 既に表示中の場合は何もしない
    if (this.element) return;

    this.element = document.createElement('div');
    this.element.className = 'screen-share-guide';
    this.element.innerHTML = `
      <div class="screen-share-guide-content">
        <div class="screen-share-guide-text">
          ${t('screenCapture.guideText')}
        </div>
        <div class="screen-share-guide-hint">
          ${t('screenCapture.guideHint')}
        </div>
        <div class="screen-share-guide-arrow">
          <i class="fa-solid fa-arrow-down"></i>
        </div>
      </div>
    `;

    // クリックで閉じる
    this.element.addEventListener('click', () => this.hide());

    // 自動で消える
    this.autoHideTimer = window.setTimeout(() => {
      this.hide();
    }, AUTO_HIDE_DELAY_MS);

    document.body.appendChild(this.element);

    console.log('[ScreenShareGuide] Guide displayed');
  }

  /**
   * ガイドを非表示
   */
  hide(): void {
    if (this.autoHideTimer !== null) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }

    if (this.element) {
      this.element.remove();
      this.element = null;
      console.log('[ScreenShareGuide] Guide hidden');
    }
  }

  /**
   * ガイドが表示中かどうか
   */
  isVisible(): boolean {
    return this.element !== null;
  }
}
