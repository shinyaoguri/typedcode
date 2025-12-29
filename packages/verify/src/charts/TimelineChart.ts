/**
 * TimelineChart - 統合タイムラインチャート
 *
 * タイピング速度、フォーカス状態、キーストロークダイナミクスを
 * 統合して表示するチャートコンポーネント。
 *
 * charts.ts から抽出。現在は後方互換のために既存関数を委譲。
 */

import type { StoredEvent, KeystrokeDynamicsData, InputType } from '@typedcode/shared';
import type { IntegratedTimelineCache } from '../types.js';
import { ChartUtils, type CanvasContext } from './ChartUtils.js';

// ============================================================================
// 型定義
// ============================================================================

/** TimelineChart の設定 */
export interface TimelineChartOptions {
  /** メインキャンバス要素 */
  canvas: HTMLCanvasElement | null;
  /** モーダル用キャンバス要素 */
  modalCanvas?: HTMLCanvasElement | null;
  /** 統計要素 */
  stats?: {
    mouseEventCount?: HTMLElement | null;
    focusEventCount?: HTMLElement | null;
    visibilityEventCount?: HTMLElement | null;
    keyDownCount?: HTMLElement | null;
    avgDwellTime?: HTMLElement | null;
    avgFlightTime?: HTMLElement | null;
  };
}

/** チャートレイアウト */
interface ChartLayout {
  focusBarHeight: number;
  visibilityBarHeight: number;
  gapBetweenBars: number;
  focusAreaHeight: number;
  speedChartHeight: number;
  keystrokeChartHeight: number;
  focusY: number;
  visibilityY: number;
  speedChartY: number;
  keystrokeY: number;
}

// ============================================================================
// TimelineChart クラス
// ============================================================================

/**
 * 統合タイムラインチャート
 */
export class TimelineChart {
  private options: TimelineChartOptions;
  private cache: IntegratedTimelineCache | null = null;
  private canvasContext: CanvasContext | null = null;

  constructor(options: TimelineChartOptions) {
    this.options = options;
  }

  /**
   * キャッシュを取得
   */
  getCache(): IntegratedTimelineCache | null {
    return this.cache;
  }

  /**
   * キャッシュを設定
   */
  setCache(cache: IntegratedTimelineCache): void {
    this.cache = cache;
  }

  /**
   * チャートを描画
   */
  draw(events: StoredEvent[], currentEvents: StoredEvent[]): void {
    if (!this.options.canvas || !events || events.length === 0) {
      return;
    }

    // イベントを抽出
    const mouseEvents = events.filter(e => e.type === 'mousePositionChange');
    const focusEvents = events.filter(e => e.type === 'focusChange');
    const visibilityEvents = events.filter(e => e.type === 'visibilityChange');
    const keyDownEvents = events.filter(e => e.type === 'keyDown');
    const keyUpEvents = events.filter(e => e.type === 'keyUp');

    // 統計情報を更新
    this.updateStats(mouseEvents, focusEvents, visibilityEvents, keyDownEvents, keyUpEvents);

    // キャンバスを初期化
    const canvasInit = ChartUtils.initCanvas(this.options.canvas);
    if (!canvasInit) return;
    this.canvasContext = canvasInit;

    const { ctx, width, height } = canvasInit;
    const padding = { top: 30, right: 20, bottom: 50, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const lastEvent = events[events.length - 1];
    const totalTime = lastEvent?.timestamp ?? 0;

    // データを準備
    const { typingSpeedData, externalInputMarkers, maxSpeed } = this.prepareTypingSpeedData(events, totalTime);
    const { keyUpData, keyDownData, maxKeystrokeTime } = this.prepareKeystrokeData(
      keyUpEvents, keyDownEvents, currentEvents
    );

    // キャッシュを保存
    this.cache = {
      totalTime,
      padding,
      chartWidth,
      chartHeight,
      typingSpeedData,
      externalInputMarkers,
      focusEvents,
      visibilityEvents,
      keyUpData,
      keyDownData,
      maxSpeed,
      maxKeystrokeTime,
    };

    // 描画
    this.drawBackground(ctx, width, height);
    const layout = this.calculateLayout(padding, chartHeight);
    this.drawFocusBars(ctx, focusEvents, visibilityEvents, padding.left, chartWidth, totalTime, layout);
    this.drawTypingSpeed(ctx, typingSpeedData, externalInputMarkers, padding, chartWidth, totalTime, maxSpeed, layout);
    this.drawKeystroke(ctx, keyUpData, keyDownData, padding, chartWidth, totalTime, maxKeystrokeTime, layout);
    this.drawTimeAxis(ctx, totalTime, padding, chartWidth, height);
  }

  /**
   * マーカーを更新
   */
  updateMarker(eventIndex: number, events: StoredEvent[]): void {
    if (!this.cache || !this.options.canvas) return;

    // 再描画してマーカーを追加
    this.redrawWithMarker(eventIndex, events);
  }

  /**
   * 統計情報を更新
   */
  private updateStats(
    mouseEvents: StoredEvent[],
    focusEvents: StoredEvent[],
    visibilityEvents: StoredEvent[],
    keyDownEvents: StoredEvent[],
    keyUpEvents: StoredEvent[]
  ): void {
    const stats = this.options.stats;
    if (!stats) return;

    if (stats.mouseEventCount) stats.mouseEventCount.textContent = String(mouseEvents.length);
    if (stats.focusEventCount) stats.focusEventCount.textContent = String(focusEvents.length);
    if (stats.visibilityEventCount) stats.visibilityEventCount.textContent = String(visibilityEvents.length);
    if (stats.keyDownCount) stats.keyDownCount.textContent = String(keyDownEvents.length);

    // Dwell/Flight Time の平均を計算
    const MAX_VALID_TIME = 10000;
    const dwellTimes = this.extractValidTimes(keyUpEvents, 'dwellTime', MAX_VALID_TIME);
    const flightTimes = this.extractValidTimes(keyDownEvents, 'flightTime', MAX_VALID_TIME);

    const avgDwellTime = dwellTimes.length > 0
      ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length
      : 0;
    const avgFlightTime = flightTimes.length > 0
      ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length
      : 0;

    if (stats.avgDwellTime) stats.avgDwellTime.textContent = `${avgDwellTime.toFixed(1)}ms`;
    if (stats.avgFlightTime) stats.avgFlightTime.textContent = `${avgFlightTime.toFixed(1)}ms`;
  }

  /**
   * 有効な時間値を抽出
   */
  private extractValidTimes(events: StoredEvent[], field: 'dwellTime' | 'flightTime', maxTime: number): number[] {
    const times: number[] = [];
    events.forEach(event => {
      const data = event.data as KeystrokeDynamicsData | null;
      if (data && typeof data === 'object' && field in data) {
        const time = data[field];
        if (time !== undefined && Number.isFinite(time) && time >= 0 && time <= maxTime) {
          times.push(time);
        }
      }
    });
    return times;
  }

  /**
   * タイピング速度データを準備
   */
  private prepareTypingSpeedData(events: StoredEvent[], totalTime: number): {
    typingSpeedData: { time: number; speed: number }[];
    externalInputMarkers: { time: number; type: InputType }[];
    maxSpeed: number;
  } {
    const windowSize = 5000;
    const typingSpeedData: { time: number; speed: number }[] = [];
    const externalInputMarkers: { time: number; type: InputType }[] = [];

    for (let time = 0; time <= totalTime; time += 1000) {
      const windowStart = Math.max(0, time - windowSize);
      const windowEnd = time;

      let charCount = 0;
      events.forEach(event => {
        if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
          if (event.type === 'contentChange' && event.data &&
              event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
            charCount += (typeof event.data === 'string' ? event.data.length : 0);
          }
        }
      });

      const speed = charCount / (windowSize / 1000);
      typingSpeedData.push({ time: time / 1000, speed });
    }

    events.forEach(event => {
      if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
        externalInputMarkers.push({
          time: event.timestamp / 1000,
          type: event.inputType
        });
      }
    });

    const maxSpeed = Math.ceil(Math.max(...typingSpeedData.map(d => d.speed), 1) * 1.2);

    return { typingSpeedData, externalInputMarkers, maxSpeed };
  }

  /**
   * キーストロークデータを準備
   */
  private prepareKeystrokeData(
    keyUpEvents: StoredEvent[],
    keyDownEvents: StoredEvent[],
    currentEvents: StoredEvent[]
  ): {
    keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[];
    keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[];
    maxKeystrokeTime: number;
  } {
    const keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[] = [];
    const keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[] = [];
    let maxKeystrokeTime = 0;

    keyUpEvents.forEach(event => {
      const data = event.data as KeystrokeDynamicsData | null;
      if (data && typeof data === 'object' && 'dwellTime' in data && data.dwellTime !== undefined) {
        const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
        keyUpData.push({
          time: event.timestamp,
          dwellTime: data.dwellTime,
          key: data.key,
          eventIndex
        });
        maxKeystrokeTime = Math.max(maxKeystrokeTime, data.dwellTime);
      }
    });

    keyDownEvents.forEach(event => {
      const data = event.data as KeystrokeDynamicsData | null;
      if (data && typeof data === 'object' && 'flightTime' in data && data.flightTime !== undefined) {
        const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
        keyDownData.push({
          time: event.timestamp,
          flightTime: data.flightTime,
          key: data.key,
          eventIndex
        });
        maxKeystrokeTime = Math.max(maxKeystrokeTime, data.flightTime);
      }
    });

    maxKeystrokeTime = Math.ceil(maxKeystrokeTime / 100) * 100 || 300;

    return { keyUpData, keyDownData, maxKeystrokeTime };
  }

  /**
   * 背景を描画
   */
  private drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  /**
   * レイアウトを計算
   */
  private calculateLayout(padding: { top: number }, chartHeight: number): ChartLayout {
    const focusBarHeight = 12;
    const visibilityBarHeight = 12;
    const gapBetweenBars = 6;
    const focusAreaHeight = focusBarHeight + gapBetweenBars + visibilityBarHeight + 20;
    const speedChartHeight = (chartHeight - focusAreaHeight) * 0.5;
    const keystrokeChartHeight = (chartHeight - focusAreaHeight) * 0.5;

    const focusY = padding.top;
    const visibilityY = focusY + focusBarHeight + gapBetweenBars;
    const speedChartY = focusY + focusAreaHeight;
    const keystrokeY = speedChartY + speedChartHeight;

    return {
      focusBarHeight,
      visibilityBarHeight,
      gapBetweenBars,
      focusAreaHeight,
      speedChartHeight,
      keystrokeChartHeight,
      focusY,
      visibilityY,
      speedChartY,
      keystrokeY,
    };
  }

  /**
   * フォーカスバーを描画
   */
  private drawFocusBars(
    ctx: CanvasRenderingContext2D,
    focusEvents: StoredEvent[],
    visibilityEvents: StoredEvent[],
    paddingLeft: number,
    chartWidth: number,
    totalTime: number,
    layout: ChartLayout
  ): void {
    // フォーカスバー
    this.drawSingleFocusBar(ctx, focusEvents, paddingLeft, layout.focusY, chartWidth, layout.focusBarHeight, totalTime, true);
    // Visibilityバー
    this.drawSingleFocusBar(ctx, visibilityEvents, paddingLeft, layout.visibilityY, chartWidth, layout.visibilityBarHeight, totalTime, false);

    // ラベル
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Focus', paddingLeft - 5, layout.focusY + layout.focusBarHeight / 2 + 3);
    ctx.fillText('Tab', paddingLeft - 5, layout.visibilityY + layout.visibilityBarHeight / 2 + 3);
  }

  /**
   * 単一のフォーカスバーを描画
   */
  private drawSingleFocusBar(
    ctx: CanvasRenderingContext2D,
    events: StoredEvent[],
    x: number,
    y: number,
    width: number,
    height: number,
    totalTime: number,
    isFocus: boolean
  ): void {
    // 背景（デフォルト状態）
    ctx.fillStyle = isFocus ? '#fee2e2' : '#e5e7eb';
    ctx.fillRect(x, y, width, height);

    if (events.length === 0) return;

    // 状態変化を描画
    let currentState = true;
    let lastTime = 0;

    events.forEach(event => {
      const eventTime = event.timestamp;
      const eventX = x + (lastTime / totalTime) * width;
      const eventWidth = ((eventTime - lastTime) / totalTime) * width;

      if (currentState) {
        ctx.fillStyle = isFocus ? '#bbf7d0' : '#dbeafe';
        ctx.fillRect(eventX, y, eventWidth, height);
      }

      // 状態を更新
      const data = event.data as { focused?: boolean; visible?: boolean } | null;
      if (data) {
        currentState = isFocus ? (data.focused ?? true) : (data.visible ?? true);
      }
      lastTime = eventTime;
    });

    // 最後の状態
    if (lastTime < totalTime) {
      const eventX = x + (lastTime / totalTime) * width;
      const eventWidth = ((totalTime - lastTime) / totalTime) * width;
      if (currentState) {
        ctx.fillStyle = isFocus ? '#bbf7d0' : '#dbeafe';
        ctx.fillRect(eventX, y, eventWidth, height);
      }
    }
  }

  /**
   * タイピング速度を描画
   */
  private drawTypingSpeed(
    ctx: CanvasRenderingContext2D,
    typingSpeedData: { time: number; speed: number }[],
    externalInputMarkers: { time: number; type: InputType }[],
    padding: { left: number },
    chartWidth: number,
    totalTime: number,
    maxSpeed: number,
    layout: ChartLayout
  ): void {
    const speedChartY = layout.speedChartY;
    const speedChartHeight = layout.speedChartHeight;

    // グリッド線
    ctx.strokeStyle = '#e9ecef';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = speedChartY + (speedChartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartWidth, y);
      ctx.stroke();
    }

    // Y軸ラベル
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = speedChartY + (speedChartHeight / 4) * i;
      const value = maxSpeed - (maxSpeed / 4) * i;
      ctx.fillText(value.toFixed(0), padding.left - 5, y + 3);
    }

    // 外部入力マーカー
    externalInputMarkers.forEach(marker => {
      const markerX = padding.left + (marker.time / (totalTime / 1000)) * chartWidth;
      ctx.fillStyle = 'rgba(255, 193, 7, 0.3)';
      ctx.fillRect(markerX - 2, speedChartY, 4, speedChartHeight);
    });

    // タイピング速度ライン
    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 2;
    ctx.beginPath();

    typingSpeedData.forEach((point, index) => {
      const pointX = padding.left + (point.time / (totalTime / 1000)) * chartWidth;
      const pointY = speedChartY + speedChartHeight - (point.speed / maxSpeed) * speedChartHeight;

      if (index === 0) {
        ctx.moveTo(pointX, pointY);
      } else {
        ctx.lineTo(pointX, pointY);
      }
    });

    ctx.stroke();
  }

  /**
   * キーストロークを描画
   */
  private drawKeystroke(
    ctx: CanvasRenderingContext2D,
    keyUpData: { time: number; dwellTime: number; key: string; eventIndex: number }[],
    keyDownData: { time: number; flightTime: number; key: string; eventIndex: number }[],
    padding: { left: number },
    chartWidth: number,
    totalTime: number,
    maxKeystrokeTime: number,
    layout: ChartLayout
  ): void {
    const keystrokeY = layout.keystrokeY;
    const keystrokeChartHeight = layout.keystrokeChartHeight;

    // グリッド線
    ctx.strokeStyle = '#e9ecef';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = keystrokeY + (keystrokeChartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartWidth, y);
      ctx.stroke();
    }

    // Y軸ラベル
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = keystrokeY + (keystrokeChartHeight / 4) * i;
      const value = maxKeystrokeTime - (maxKeystrokeTime / 4) * i;
      ctx.fillText(`${value.toFixed(0)}`, padding.left - 5, y + 3);
    }

    // Dwell Time（上半分）
    keyUpData.forEach(point => {
      const pointX = padding.left + (point.time / totalTime) * chartWidth;
      const normalizedDwell = Math.min(point.dwellTime / maxKeystrokeTime, 1);
      const pointY = keystrokeY + keystrokeChartHeight * 0.5 - normalizedDwell * keystrokeChartHeight * 0.4;
      ctx.fillStyle = 'rgba(102, 126, 234, 0.6)';
      ctx.beginPath();
      ctx.arc(pointX, pointY, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Flight Time（下半分）
    keyDownData.forEach(point => {
      const pointX = padding.left + (point.time / totalTime) * chartWidth;
      const normalizedFlight = Math.min(point.flightTime / maxKeystrokeTime, 1);
      const pointY = keystrokeY + keystrokeChartHeight * 0.5 + normalizedFlight * keystrokeChartHeight * 0.4;
      ctx.fillStyle = 'rgba(237, 100, 166, 0.6)';
      ctx.beginPath();
      ctx.arc(pointX, pointY, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /**
   * 時間軸を描画
   */
  private drawTimeAxis(
    ctx: CanvasRenderingContext2D,
    totalTime: number,
    padding: { left: number; bottom: number },
    chartWidth: number,
    height: number
  ): void {
    const axisY = height - padding.bottom + 20;

    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';

    const tickCount = 10;
    for (let i = 0; i <= tickCount; i++) {
      const tickX = padding.left + (chartWidth / tickCount) * i;
      const time = (totalTime / tickCount) * i;
      ctx.fillText(ChartUtils.formatTimeShort(time), tickX, axisY);
    }
  }

  /**
   * マーカー付きで再描画
   */
  private redrawWithMarker(eventIndex: number, events: StoredEvent[]): void {
    // 完全な再実装は後のフェーズで行う
    // 現在は既存の charts.ts 関数を使用
  }

  /**
   * チャートを表示
   */
  show(): void {
    if (this.options.canvas) {
      const parent = this.options.canvas.parentElement;
      if (parent) parent.style.display = 'block';
    }
  }

  /**
   * チャートを非表示
   */
  hide(): void {
    if (this.options.canvas) {
      const parent = this.options.canvas.parentElement;
      if (parent) parent.style.display = 'none';
    }
  }
}
