/**
 * SeekbarController - シークバーコントローラー
 *
 * タイムラインのシークバー操作を管理するコントローラー。
 * seekbar.ts から抽出。
 */

import type { StoredEvent } from '@typedcode/shared';
import type { ContentCache } from '../types.js';
import { ChartUtils } from './ChartUtils.js';
import type { IntegratedChart } from './IntegratedChart.js';

// ============================================================================
// 型定義
// ============================================================================

/** SeekbarController の設定 */
export interface SeekbarControllerOptions {
  /** フローティングシークバー要素 */
  floatingSeekbar: HTMLElement | null;
  /** スライダー要素 */
  slider: HTMLInputElement | null;
  /** 進捗バー要素 */
  progressBar: HTMLElement | null;
  /** 時間表示要素 */
  timeDisplay: HTMLElement | null;
  /** イベント数表示要素 */
  eventCountDisplay: HTMLElement | null;
  /** 先頭ボタン */
  startButton: HTMLElement | null;
  /** 前へボタン */
  prevButton: HTMLElement | null;
  /** 再生ボタン */
  playButton: HTMLElement | null;
  /** 再生アイコン要素 */
  playIcon: HTMLElement | null;
  /** 次へボタン */
  nextButton: HTMLElement | null;
  /** 終端ボタン */
  endButton: HTMLElement | null;
  /** コンテンツプレビュー要素 */
  contentPreview: HTMLElement | null;
}

/** シークバーコールバック */
export interface SeekbarCallbacks {
  /** 位置変更時 */
  onSeek?: (eventIndex: number) => void;
  /** 再生状態変更時 */
  onPlayStateChange?: (isPlaying: boolean) => void;
}

// ============================================================================
// SeekbarController クラス
// ============================================================================

/**
 * シークバーコントローラー
 */
export class SeekbarController {
  private options: SeekbarControllerOptions;
  private callbacks: SeekbarCallbacks;

  // 状態
  private events: StoredEvent[] = [];
  private currentIndex: number = 0;
  private isPlaying: boolean = false;
  private playInterval: ReturnType<typeof setInterval> | null = null;
  private finalContent: string = '';
  private contentCache: ContentCache = new Map();

  // Chart.js連携
  private integratedChart: IntegratedChart | null = null;

  // イベントリスナーの参照（クリーンアップ用）
  private boundHandlers: {
    onSliderInput?: (e: Event) => void;
    onStartClick?: () => void;
    onPrevClick?: () => void;
    onPlayClick?: () => void;
    onNextClick?: () => void;
    onEndClick?: () => void;
  } = {};

  constructor(options: SeekbarControllerOptions, callbacks: SeekbarCallbacks = {}) {
    this.options = options;
    this.callbacks = callbacks;
  }

  /**
   * シークバーを初期化
   */
  initialize(events: StoredEvent[], finalContent: string): void {
    if (!events || events.length === 0) return;

    this.events = events;
    this.finalContent = finalContent;
    this.currentIndex = events.length;
    this.contentCache.clear();

    // シークバーを表示
    if (this.options.floatingSeekbar) {
      this.options.floatingSeekbar.style.display = 'flex';
    }

    // スライダーを設定
    if (this.options.slider) {
      this.options.slider.max = String(events.length);
      this.options.slider.value = String(events.length);
    }

    this.updateUI();
  }

  /**
   * イベントリスナーを設定
   */
  setupEventListeners(): void {
    // スライダー
    if (this.options.slider) {
      this.boundHandlers.onSliderInput = (e: Event) => {
        const value = parseInt((e.target as HTMLInputElement).value, 10);
        this.seekTo(value);
      };
      this.options.slider.addEventListener('input', this.boundHandlers.onSliderInput);
    }

    // ボタン
    if (this.options.startButton) {
      this.boundHandlers.onStartClick = () => this.seekTo(0);
      this.options.startButton.addEventListener('click', this.boundHandlers.onStartClick);
    }

    if (this.options.prevButton) {
      this.boundHandlers.onPrevClick = () => this.seekTo(Math.max(0, this.currentIndex - 1));
      this.options.prevButton.addEventListener('click', this.boundHandlers.onPrevClick);
    }

    if (this.options.playButton) {
      this.boundHandlers.onPlayClick = () => this.togglePlay();
      this.options.playButton.addEventListener('click', this.boundHandlers.onPlayClick);
    }

    if (this.options.nextButton) {
      this.boundHandlers.onNextClick = () => this.seekTo(Math.min(this.events.length, this.currentIndex + 1));
      this.options.nextButton.addEventListener('click', this.boundHandlers.onNextClick);
    }

    if (this.options.endButton) {
      this.boundHandlers.onEndClick = () => this.seekTo(this.events.length);
      this.options.endButton.addEventListener('click', this.boundHandlers.onEndClick);
    }
  }

  /**
   * イベントリスナーを削除
   */
  removeEventListeners(): void {
    if (this.options.slider && this.boundHandlers.onSliderInput) {
      this.options.slider.removeEventListener('input', this.boundHandlers.onSliderInput);
    }
    if (this.options.startButton && this.boundHandlers.onStartClick) {
      this.options.startButton.removeEventListener('click', this.boundHandlers.onStartClick);
    }
    if (this.options.prevButton && this.boundHandlers.onPrevClick) {
      this.options.prevButton.removeEventListener('click', this.boundHandlers.onPrevClick);
    }
    if (this.options.playButton && this.boundHandlers.onPlayClick) {
      this.options.playButton.removeEventListener('click', this.boundHandlers.onPlayClick);
    }
    if (this.options.nextButton && this.boundHandlers.onNextClick) {
      this.options.nextButton.removeEventListener('click', this.boundHandlers.onNextClick);
    }
    if (this.options.endButton && this.boundHandlers.onEndClick) {
      this.options.endButton.removeEventListener('click', this.boundHandlers.onEndClick);
    }
    this.boundHandlers = {};
  }

  /**
   * Chart.jsチャートを設定
   */
  setIntegratedChart(chart: IntegratedChart | null): void {
    this.integratedChart = chart;
  }

  /**
   * 指定位置にシーク
   */
  seekTo(index: number): void {
    this.currentIndex = ChartUtils.clamp(index, 0, this.events.length);
    this.updateUI();
    this.callbacks.onSeek?.(this.currentIndex);

    // Chart.jsマーカーを更新
    this.updateChartMarker();
  }

  /**
   * 時間指定でシーク（Chart.jsからの呼び出し用）
   */
  seekToTime(timestamp: number): void {
    const index = this.findEventIndexAtTime(timestamp);
    this.seekTo(index);
  }

  /**
   * Chart.jsマーカーを更新
   */
  private updateChartMarker(): void {
    if (!this.integratedChart) return;

    if (this.currentIndex > 0 && this.currentIndex <= this.events.length) {
      const event = this.events[Math.min(this.currentIndex - 1, this.events.length - 1)];
      if (event) {
        this.integratedChart.updateMarker(event.timestamp);
      }
    } else if (this.currentIndex === 0) {
      this.integratedChart.clearMarker();
    }
  }

  /**
   * 時間に対応するイベントインデックスを検索
   */
  private findEventIndexAtTime(timestamp: number): number {
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (event && event.timestamp >= timestamp) {
        return i;
      }
    }
    return this.events.length;
  }

  /**
   * 再生/一時停止を切り替え
   */
  togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * 再生開始
   */
  play(): void {
    if (this.isPlaying) return;

    // 終端にいる場合は最初から
    if (this.currentIndex >= this.events.length) {
      this.currentIndex = 0;
    }

    this.isPlaying = true;
    this.updatePlayIcon();
    this.callbacks.onPlayStateChange?.(true);

    this.playInterval = setInterval(() => {
      if (this.currentIndex >= this.events.length) {
        this.pause();
        return;
      }

      this.currentIndex++;
      this.updateUI();
      this.updateChartMarker();
      this.callbacks.onSeek?.(this.currentIndex);
    }, 50); // 50ms間隔
  }

  /**
   * 一時停止
   */
  pause(): void {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    if (this.playInterval) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
    this.updatePlayIcon();
    this.callbacks.onPlayStateChange?.(false);
  }

  /**
   * UIを更新
   */
  private updateUI(): void {
    // スライダー
    if (this.options.slider) {
      this.options.slider.value = String(this.currentIndex);
    }

    // 進捗バー
    if (this.options.progressBar) {
      const progress = this.events.length > 0 ? (this.currentIndex / this.events.length) * 100 : 0;
      this.options.progressBar.style.width = `${progress}%`;
    }

    // 時間表示
    if (this.options.timeDisplay && this.events.length > 0) {
      const currentEvent = this.events[Math.min(this.currentIndex, this.events.length - 1)];
      const currentTime = currentEvent?.timestamp ?? 0;
      const totalTime = this.events[this.events.length - 1]?.timestamp ?? 0;
      this.options.timeDisplay.textContent = `${ChartUtils.formatTime(currentTime)} / ${ChartUtils.formatTime(totalTime)}`;
    }

    // イベント数表示
    if (this.options.eventCountDisplay) {
      this.options.eventCountDisplay.textContent = `${this.currentIndex} / ${this.events.length}`;
    }

    // コンテンツプレビュー
    if (this.options.contentPreview) {
      const content = this.getContentAtIndex(this.currentIndex);
      this.options.contentPreview.textContent = content;
    }
  }

  /**
   * 再生アイコンを更新
   */
  private updatePlayIcon(): void {
    if (this.options.playIcon) {
      this.options.playIcon.textContent = this.isPlaying ? '⏸' : '▶';
    }
  }

  /**
   * 指定インデックスまでのコンテンツを再構築（公開メソッド）
   */
  getContentAtIndex(index: number): string {
    if (this.contentCache.has(index)) {
      return this.contentCache.get(index)!;
    }

    if (index === 0) {
      this.contentCache.set(index, '');
      return '';
    }

    if (index >= this.events.length) {
      return this.finalContent;
    }

    // 近いキャッシュを探す
    let nearestCacheIndex = 0;
    let nearestContent = '';

    for (const [cachedIndex, cachedContent] of this.contentCache.entries()) {
      if (cachedIndex <= index && cachedIndex > nearestCacheIndex) {
        nearestCacheIndex = cachedIndex;
        nearestContent = cachedContent;
      }
    }

    // キャッシュから構築
    let content = nearestContent;
    for (let i = nearestCacheIndex; i < index; i++) {
      const event = this.events[i];
      if (event && event.type === 'contentChange') {
        content = this.applyContentChange(content, event);
      }
    }

    // 定期的にキャッシュ
    if (index % 100 === 0) {
      this.contentCache.set(index, content);
    }

    return content;
  }

  /**
   * コンテンツ変更を適用
   */
  private applyContentChange(content: string, event: StoredEvent): string {
    const data = event.data as string | null;
    const rangeOffset = event.rangeOffset ?? 0;
    const rangeLength = event.rangeLength ?? 0;

    if (rangeLength > 0) {
      // 削除
      content = content.slice(0, rangeOffset) + content.slice(rangeOffset + rangeLength);
    }

    if (data && typeof data === 'string') {
      // 挿入
      content = content.slice(0, rangeOffset) + data + content.slice(rangeOffset);
    }

    return content;
  }

  /**
   * 現在のインデックスを取得
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * イベント配列を取得
   */
  getEvents(): StoredEvent[] {
    return this.events;
  }

  /**
   * 再生中かどうか
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * シークバーを表示
   */
  show(): void {
    if (this.options.floatingSeekbar) {
      this.options.floatingSeekbar.style.display = 'flex';
    }
  }

  /**
   * シークバーを非表示
   */
  hide(): void {
    this.pause();
    if (this.options.floatingSeekbar) {
      this.options.floatingSeekbar.style.display = 'none';
    }
  }

  /**
   * クリーンアップ
   */
  destroy(): void {
    this.pause();
    this.removeEventListeners();
    this.events = [];
    this.contentCache.clear();
  }
}
