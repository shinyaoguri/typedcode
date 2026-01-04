/**
 * ScreenshotOverlay - スクリーンショットホバープレビュー
 *
 * チャート上のスクリーンショットポイントにホバーした時に
 * 小さなプレビュー画像を表示するオーバーレイ。
 */

import type { VerifyScreenshot } from '../types.js';
import type { ScreenshotService } from '../services/ScreenshotService.js';

/**
 * スクリーンショットプレビューオーバーレイ
 */
export class ScreenshotOverlay {
  private overlay: HTMLElement;
  private previewImage: HTMLImageElement;
  private typeEl: HTMLElement;
  private timeEl: HTMLElement;
  private screenshotService: ScreenshotService;
  private isVisible: boolean = false;
  private hideTimeout: number | null = null;

  constructor(screenshotService: ScreenshotService) {
    this.screenshotService = screenshotService;
    this.overlay = this.createDOM();
    this.previewImage = this.overlay.querySelector('.screenshot-preview-image')!;
    this.typeEl = this.overlay.querySelector('.screenshot-preview-type')!;
    this.timeEl = this.overlay.querySelector('.screenshot-preview-time')!;
    this.setupEventListeners();
  }

  /**
   * DOM要素を作成
   */
  private createDOM(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'screenshot-preview-overlay';
    overlay.innerHTML = `
      <div class="screenshot-preview-container">
        <img class="screenshot-preview-image" src="" alt="Preview">
        <div class="screenshot-preview-info">
          <span class="screenshot-preview-type"></span>
          <span class="screenshot-preview-time"></span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * イベントリスナーを設定
   */
  private setupEventListeners(): void {
    // ホバーで消えないようにする
    this.overlay.addEventListener('mouseenter', () => {
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
    });

    this.overlay.addEventListener('mouseleave', () => {
      this.hide();
    });
  }

  /**
   * プレビューを表示
   */
  show(screenshot: VerifyScreenshot, x: number, y: number): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    const imageUrl = this.screenshotService.getImageUrl(screenshot.id);
    if (imageUrl) {
      this.previewImage.src = imageUrl;
      this.previewImage.style.display = 'block';
    } else {
      this.previewImage.style.display = 'none';
    }

    // 情報を更新
    const typeMap: Record<string, string> = {
      periodic: '定期',
      focusLost: 'フォーカス喪失',
      manual: '手動',
    };

    this.typeEl.textContent = typeMap[screenshot.captureType] ?? screenshot.captureType;
    this.timeEl.textContent = this.formatTime(screenshot.timestamp);

    // 表示してからサイズを取得
    this.overlay.classList.add('visible');
    this.isVisible = true;

    // 位置を調整（画面外に出ないように）
    requestAnimationFrame(() => {
      const rect = this.overlay.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let posX = x + 15;
      let posY = y + 15;

      if (posX + rect.width > viewportWidth - 10) {
        posX = x - rect.width - 15;
      }

      if (posY + rect.height > viewportHeight - 10) {
        posY = y - rect.height - 15;
      }

      // 最低でも画面内に収まるように
      posX = Math.max(10, posX);
      posY = Math.max(10, posY);

      this.overlay.style.left = `${posX}px`;
      this.overlay.style.top = `${posY}px`;
    });
  }

  /**
   * プレビューを非表示（遅延あり）
   */
  hide(): void {
    if (this.hideTimeout) return;

    this.hideTimeout = window.setTimeout(() => {
      this.overlay.classList.remove('visible');
      this.isVisible = false;
      this.hideTimeout = null;
    }, 150);
  }

  /**
   * 即座に非表示
   */
  hideImmediate(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.overlay.classList.remove('visible');
    this.isVisible = false;
  }

  /**
   * 表示中かどうか
   */
  getIsVisible(): boolean {
    return this.isVisible;
  }

  /**
   * 時間をフォーマット
   */
  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * クリーンアップ
   */
  destroy(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }
    this.overlay.remove();
  }
}
