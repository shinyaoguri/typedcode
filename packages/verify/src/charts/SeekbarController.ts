/**
 * SeekbarController - シークバーコントローラー
 *
 * タイムラインのシークバー操作を管理するコントローラー。
 * seekbar.ts から抽出。
 */

import {
  escapeHtml,
  type StoredEvent,
  type TemplateInjectionEventData,
  type ProcessKeyMoment,
} from '@typedcode/shared';
import type { ContentCache } from '../types.js';
import { ChartUtils } from './ChartUtils.js';
import type { IntegratedChart } from './IntegratedChart.js';

/**
 * 再生モード (Phase 8 W3-C)。
 * - steps: 50ms ごとに 1 イベント (等間隔・従来挙動)
 * - x1/x10/x60: イベントの実 timestamp に比例した再生 (停止・バーストの緩急が見える)
 */
export type PlaybackMode = 'steps' | 'x1' | 'x10' | 'x60';

const PLAYBACK_MODE_ORDER: PlaybackMode[] = ['steps', 'x1', 'x10', 'x60'];
const PLAYBACK_MODE_LABEL: Record<PlaybackMode, string> = {
  steps: '=',
  x1: '×1',
  x10: '×10',
  x60: '×60',
};
const PLAYBACK_SPEED: Record<Exclude<PlaybackMode, 'steps'>, number> = {
  x1: 1,
  x10: 10,
  x60: 60,
};
const PLAY_TICK_MS = 50;

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
  /** 再生速度ボタン (W3-C。クリックでモード巡回) */
  speedButton?: HTMLElement | null;
  /** 見どころマーカーのコンテナ (W3-C。トラック上に重ねる) */
  markersContainer?: HTMLElement | null;
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
  /** 再生モード (W3-C)。既定は従来挙動の等間隔。 */
  private playbackMode: PlaybackMode = 'steps';
  /** 実時間比例再生の仮想時刻 (イベント timestamp 系の ms)。 */
  private virtualTimeMs = 0;

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
    onSpeedClick?: () => void;
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
    this.contentCache.clear();
    // content が渡されない (proof.json 単体 = ソースファイルなし) ときは events から
    // 最終状態を再構成する。これがないと最終インデックスの再生が空になる。
    this.finalContent = finalContent || this.reconstructFinalContent(events);
    this.currentIndex = events.length;

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

    if (this.options.speedButton) {
      this.boundHandlers.onSpeedClick = () => this.cyclePlaybackMode();
      this.options.speedButton.addEventListener('click', this.boundHandlers.onSpeedClick);
      this.updateSpeedButton();
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
    if (this.options.speedButton && this.boundHandlers.onSpeedClick) {
      this.options.speedButton.removeEventListener('click', this.boundHandlers.onSpeedClick);
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
    this.resetVirtualClock();

    this.playInterval = setInterval(() => {
      if (this.currentIndex >= this.events.length) {
        this.pause();
        return;
      }

      if (this.playbackMode === 'steps') {
        // 従来挙動: tick ごとに 1 イベント (等間隔)
        this.currentIndex++;
      } else {
        // 実時間比例: 仮想時刻を speed 倍で進め、追い越したイベントを適用する。
        // 長い停止は ×1 では実際に待たされる (それが見どころ)。×10/×60 で早送り。
        this.virtualTimeMs += PLAY_TICK_MS * PLAYBACK_SPEED[this.playbackMode];
        while (
          this.currentIndex < this.events.length &&
          this.events[this.currentIndex]!.timestamp <= this.virtualTimeMs
        ) {
          this.currentIndex++;
        }
      }

      this.updateUI();
      this.updateChartMarker();
      this.callbacks.onSeek?.(this.currentIndex);
    }, PLAY_TICK_MS);
  }

  /** 現在位置から実時間比例再生の仮想時刻を引き直す。 */
  private resetVirtualClock(): void {
    if (this.events.length === 0) return;
    this.virtualTimeMs =
      this.currentIndex > 0
        ? this.events[Math.min(this.currentIndex, this.events.length) - 1]!.timestamp
        : this.events[0]!.timestamp - PLAY_TICK_MS;
  }

  /** 再生モードを巡回 (W3-C)。再生中は仮想時刻を引き直して滑らかに切替。 */
  cyclePlaybackMode(): void {
    const i = PLAYBACK_MODE_ORDER.indexOf(this.playbackMode);
    this.playbackMode = PLAYBACK_MODE_ORDER[(i + 1) % PLAYBACK_MODE_ORDER.length]!;
    this.resetVirtualClock();
    this.updateSpeedButton();
  }

  getPlaybackMode(): PlaybackMode {
    return this.playbackMode;
  }

  private updateSpeedButton(): void {
    if (this.options.speedButton) {
      this.options.speedButton.textContent = PLAYBACK_MODE_LABEL[this.playbackMode];
    }
  }

  /**
   * 見どころマーカー (W3-C) をトラック上に描画する。
   * ProcessSummary.moments を受け、クリックで当該イベント適用後の状態へシークする。
   */
  setKeyMoments(moments: readonly ProcessKeyMoment[]): void {
    const container = this.options.markersContainer;
    if (!container) return;
    container.innerHTML = '';
    if (this.events.length === 0) return;

    for (const moment of moments) {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `seek-marker seek-marker-${moment.kind}`;
      const position = ((moment.fromEventIndex + 1) / this.events.length) * 100;
      marker.style.left = `${Math.min(100, position)}%`;
      marker.title = `${moment.kind} @ #${moment.fromEventIndex}`;
      marker.addEventListener('click', () => this.seekTo(moment.fromEventIndex + 1));
      container.appendChild(marker);
    }
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

    // コンテンツプレビュー（行番号付き）
    if (this.options.contentPreview) {
      const content = this.getContentAtIndex(this.currentIndex);
      const withLineNumbers = this.addLineNumbers(content);
      this.options.contentPreview.innerHTML = withLineNumbers;
      this.options.contentPreview.classList.add('with-line-numbers');
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
   * 指定インデックスまでのイベントを処理した後のコンテンツを再構築（公開メソッド）
   *
   * インデックスの意味:
   * - index=0: 何もイベントが処理されていない状態（空文字列）
   * - index=1: イベント[0]が処理された後の状態
   * - index=N: イベント[0]〜[N-1]が処理された後の状態
   * - index=events.length: 全イベントが処理された後の状態（最終状態）
   */
  getContentAtIndex(index: number): string {
    // キャッシュキー
    const cacheKey = index;
    if (this.contentCache.has(cacheKey)) {
      return this.contentCache.get(cacheKey)!;
    }

    // インデックス0は開始状態（空）
    if (index <= 0) {
      this.contentCache.set(0, '');
      return '';
    }

    // インデックスがイベント数以上なら最終状態
    if (index >= this.events.length) {
      return this.finalContent;
    }

    // 近いキャッシュを探す（index未満で最大のもの）
    let nearestCacheIndex = 0;
    let nearestContent = '';

    for (const [cachedIndex, cachedContent] of this.contentCache.entries()) {
      if (cachedIndex < index && cachedIndex >= nearestCacheIndex) {
        nearestCacheIndex = cachedIndex;
        nearestContent = cachedContent;
      }
    }

    // キャッシュから構築
    // nearestCacheIndex個のイベントが処理された状態から、index個のイベントが処理された状態まで
    // つまり、イベント[nearestCacheIndex]〜[index-1]を適用
    let content = nearestContent;
    for (let i = nearestCacheIndex; i < index; i++) {
      const event = this.events[i];
      if (event) {
        if (event.type === 'contentChange') {
          content = this.applyContentChange(content, event);
        } else if (event.type === 'templateInjection') {
          // テンプレート注入: コンテンツを置き換え
          content = this.applyTemplateInjection(event);
        }
      }
    }

    // 定期的にキャッシュ
    if (index % 100 === 0) {
      this.contentCache.set(cacheKey, content);
    }

    return content;
  }

  /**
   * 全イベントを順に適用して最終コンテンツを再構成する (content 未提供時のフォールバック)。
   */
  private reconstructFinalContent(events: StoredEvent[]): string {
    let content = '';
    for (const event of events) {
      if (event.type === 'contentChange') {
        content = this.applyContentChange(content, event);
      } else if (event.type === 'templateInjection') {
        content = this.applyTemplateInjection(event);
      }
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
   * コンテンツに行番号を追加
   */
  private addLineNumbers(content: string): string {
    const lines = content.split('\n');
    return lines
      .map((line, i) => {
        const escapedLine = escapeHtml(line);
        return `<div class="code-line"><span class="line-number">${i + 1}</span><span class="line-content">${escapedLine}</span></div>`;
      })
      .join('');
  }

  /**
   * テンプレート注入を適用（コンテンツを置き換え）
   */
  private applyTemplateInjection(event: StoredEvent): string {
    const data = event.data as TemplateInjectionEventData | null;
    if (data && typeof data === 'object' && 'content' in data && typeof data.content === 'string') {
      console.log('[SeekbarController] Applied templateInjection:', {
        filename: data.filename,
        contentLength: data.content.length,
        contentPreview: data.content.substring(0, 50),
      });
      return data.content;
    }
    // 古い形式のイベント（contentがない場合）
    // 新しいプルーフを作成し直す必要があります
    console.warn(
      '[SeekbarController] templateInjection event has no content field. This proof was created before the fix. Please re-import the template and export again.',
      data
    );
    return '';
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
