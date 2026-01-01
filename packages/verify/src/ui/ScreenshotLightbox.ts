/**
 * ScreenshotLightbox - スクリーンショットライトボックスUI
 *
 * スクリーンショットをクリックした時にフルスクリーンで表示するライトボックス。
 * 前後ナビゲーション、キーボードショートカット対応。
 */

import type { VerifyScreenshot } from '../types.js';
import type { ScreenshotService } from '../services/ScreenshotService.js';

/** ライトボックス設定 */
export interface LightboxOptions {
  /** スクリーンショットサービス */
  screenshotService: ScreenshotService;
  /** 閉じる時のコールバック */
  onClose?: () => void;
  /** ナビゲート時のコールバック */
  onNavigate?: (screenshot: VerifyScreenshot) => void;
}

/**
 * スクリーンショットライトボックス
 */
export class ScreenshotLightbox {
  private overlay: HTMLElement;
  private imageEl: HTMLImageElement;
  private prevButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;
  private counterEl: HTMLElement;
  private typeEl: HTMLElement;
  private timeEl: HTMLElement;
  private resolutionEl: HTMLElement;
  private verifiedEl: HTMLElement;

  private screenshots: VerifyScreenshot[] = [];
  private currentIndex: number = 0;
  private options: LightboxOptions;
  private isOpen: boolean = false;
  private boundKeyHandler: (e: KeyboardEvent) => void;

  constructor(options: LightboxOptions) {
    this.options = options;
    this.overlay = this.createDOM();

    // 要素を取得
    this.imageEl = this.overlay.querySelector('.lightbox-image')!;
    this.prevButton = this.overlay.querySelector('.lightbox-prev')!;
    this.nextButton = this.overlay.querySelector('.lightbox-next')!;
    this.closeButton = this.overlay.querySelector('.lightbox-close')!;
    this.counterEl = this.overlay.querySelector('#lb-counter')!;
    this.typeEl = this.overlay.querySelector('#lb-type')!;
    this.timeEl = this.overlay.querySelector('#lb-time')!;
    this.resolutionEl = this.overlay.querySelector('#lb-resolution')!;
    this.verifiedEl = this.overlay.querySelector('#lb-verified')!;

    this.boundKeyHandler = this.handleKeyDown.bind(this);
    this.setupEventListeners();
  }

  /**
   * DOM要素を作成
   */
  private createDOM(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = `
      <div class="lightbox-container">
        <button class="lightbox-close" title="閉じる (Esc)">
          <i class="fas fa-times"></i>
        </button>

        <button class="lightbox-nav lightbox-prev" title="前へ (←)">
          <i class="fas fa-chevron-left"></i>
        </button>

        <div class="lightbox-image-wrapper">
          <img class="lightbox-image" src="" alt="Screenshot">
          <div class="lightbox-loading">
            <i class="fas fa-spinner fa-spin"></i>
          </div>
        </div>

        <button class="lightbox-nav lightbox-next" title="次へ (→)">
          <i class="fas fa-chevron-right"></i>
        </button>

        <div class="lightbox-info">
          <div class="lightbox-info-row">
            <span class="lightbox-info-label">タイプ:</span>
            <span class="lightbox-info-value" id="lb-type"></span>
          </div>
          <div class="lightbox-info-row">
            <span class="lightbox-info-label">時刻:</span>
            <span class="lightbox-info-value" id="lb-time"></span>
          </div>
          <div class="lightbox-info-row">
            <span class="lightbox-info-label">解像度:</span>
            <span class="lightbox-info-value" id="lb-resolution"></span>
          </div>
          <div class="lightbox-info-row">
            <span class="lightbox-info-label">ハッシュ検証:</span>
            <span class="lightbox-info-value" id="lb-verified"></span>
          </div>
          <div class="lightbox-counter">
            <span id="lb-counter">1 / 1</span>
          </div>
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
    this.closeButton.addEventListener('click', () => this.close());
    this.prevButton.addEventListener('click', () => this.navigate(-1));
    this.nextButton.addEventListener('click', () => this.navigate(1));

    // オーバーレイクリックで閉じる
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // 画像ロード完了時
    this.imageEl.addEventListener('load', () => {
      this.overlay.classList.remove('loading');
    });

    this.imageEl.addEventListener('error', () => {
      this.overlay.classList.remove('loading');
    });
  }

  /**
   * キーボードイベントハンドラ
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.navigate(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.navigate(1);
        break;
      case 'Home':
        e.preventDefault();
        this.goToFirst();
        break;
      case 'End':
        e.preventDefault();
        this.goToLast();
        break;
    }
  }

  /**
   * スクリーンショット一覧を設定
   */
  setScreenshots(screenshots: VerifyScreenshot[]): void {
    this.screenshots = screenshots;
  }

  /**
   * ライトボックスを開く
   */
  open(screenshot: VerifyScreenshot): void {
    const index = this.screenshots.findIndex((s) => s.id === screenshot.id);
    if (index === -1) {
      console.warn('Screenshot not found in list:', screenshot.id);
      return;
    }

    this.currentIndex = index;
    this.isOpen = true;
    this.overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // キーボードイベントを登録
    document.addEventListener('keydown', this.boundKeyHandler);

    this.showCurrentScreenshot();
  }

  /**
   * ライトボックスを閉じる
   */
  close(): void {
    this.isOpen = false;
    this.overlay.classList.remove('active');
    document.body.style.overflow = '';

    // キーボードイベントを解除
    document.removeEventListener('keydown', this.boundKeyHandler);

    this.options.onClose?.();
  }

  /**
   * 開いているかどうか
   */
  getIsOpen(): boolean {
    return this.isOpen;
  }

  /**
   * 前/次に移動
   */
  private navigate(direction: -1 | 1): void {
    const newIndex = this.currentIndex + direction;
    if (newIndex < 0 || newIndex >= this.screenshots.length) return;

    this.currentIndex = newIndex;
    this.showCurrentScreenshot();

    const current = this.screenshots[this.currentIndex];
    if (current) {
      this.options.onNavigate?.(current);
    }
  }

  /**
   * 最初に移動
   */
  private goToFirst(): void {
    if (this.currentIndex === 0) return;
    this.currentIndex = 0;
    this.showCurrentScreenshot();

    const current = this.screenshots[this.currentIndex];
    if (current) {
      this.options.onNavigate?.(current);
    }
  }

  /**
   * 最後に移動
   */
  private goToLast(): void {
    if (this.currentIndex === this.screenshots.length - 1) return;
    this.currentIndex = this.screenshots.length - 1;
    this.showCurrentScreenshot();

    const current = this.screenshots[this.currentIndex];
    if (current) {
      this.options.onNavigate?.(current);
    }
  }

  /**
   * 現在のスクリーンショットを表示
   */
  private showCurrentScreenshot(): void {
    const screenshot = this.screenshots[this.currentIndex];
    if (!screenshot) return;

    // ローディング状態
    this.overlay.classList.add('loading');

    // 画像を読み込み
    const imageUrl = this.options.screenshotService.getImageUrl(screenshot.id);
    if (imageUrl) {
      this.imageEl.src = imageUrl;
      this.imageEl.style.display = 'block';
    } else {
      this.imageEl.style.display = 'none';
      this.overlay.classList.remove('loading');
    }

    // 情報を更新
    const typeMap: Record<string, string> = {
      periodic: '定期キャプチャ',
      focusLost: 'フォーカス喪失',
      manual: '手動',
    };

    this.typeEl.textContent = typeMap[screenshot.captureType] ?? screenshot.captureType;
    this.timeEl.textContent = this.formatTime(screenshot.timestamp);
    this.resolutionEl.textContent = `${screenshot.displayInfo.width} x ${screenshot.displayInfo.height}`;

    // 検証状態
    if (screenshot.verified) {
      this.verifiedEl.textContent = '✓ 検証済み';
      this.verifiedEl.className = 'lightbox-info-value verified';
    } else {
      this.verifiedEl.textContent = '未検証';
      this.verifiedEl.className = 'lightbox-info-value unverified';
    }

    // カウンター
    this.counterEl.textContent = `${this.currentIndex + 1} / ${this.screenshots.length}`;

    // ナビゲーションボタンの状態
    this.prevButton.disabled = this.currentIndex === 0;
    this.nextButton.disabled = this.currentIndex === this.screenshots.length - 1;
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
    document.removeEventListener('keydown', this.boundKeyHandler);
    this.overlay.remove();
  }
}
