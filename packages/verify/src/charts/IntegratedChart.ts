/**
 * IntegratedChart - Chart.jsベースの統合タイムラインチャート
 *
 * 全イベント（タイピング速度、キーストローク、フォーカス状態、外部入力、スクリーンショット）を
 * 統合して表示するチャートコンポーネント。
 */

import {
  Chart,
  LineController,
  ScatterController,
  LineElement,
  PointElement,
  LinearScale,
  Legend,
  Tooltip,
  Filler,
  type ChartConfiguration,
  type ChartDataset,
  type Point,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import zoomPlugin from 'chartjs-plugin-zoom';
import type { StoredEvent, KeystrokeDynamicsData, InputType } from '@typedcode/shared';
import type { VerifyScreenshot, IntegratedChartCache } from '../types.js';

// Chart.js登録
Chart.register(
  LineController,
  ScatterController,
  LineElement,
  PointElement,
  LinearScale,
  Legend,
  Tooltip,
  Filler,
  annotationPlugin,
  zoomPlugin
);

// ============================================================================
// 型定義
// ============================================================================

/** IntegratedChart の設定 */
export interface IntegratedChartOptions {
  /** キャンバス要素 */
  canvas: HTMLCanvasElement;
  /** スクリーンショットホバー時 */
  onScreenshotHover?: (screenshot: VerifyScreenshot | null, x: number, y: number) => void;
  /** スクリーンショットクリック時 */
  onScreenshotClick?: (screenshot: VerifyScreenshot) => void;
  /** 時間選択時（シークバー連携） */
  onTimeSelect?: (timestamp: number, eventIndex: number) => void;
}

/** チャート描画オプション */
export interface IntegratedChartDrawOptions {
  /** 記録開始時刻（Unix timestamp ms）- X軸を実時刻で表示するため */
  startTimestamp?: number;
}

/** スクリーンショットポイントデータ */
interface ScreenshotPointData extends Point {
  screenshot: VerifyScreenshot;
}

// ============================================================================
// IntegratedChart クラス
// ============================================================================

/**
 * Chart.jsベースの統合タイムラインチャート
 */
export class IntegratedChart {
  private chart: Chart | null = null;
  private options: IntegratedChartOptions;
  private cache: IntegratedChartCache | null = null;
  private currentMarkerTimestamp: number | null = null;

  constructor(options: IntegratedChartOptions) {
    this.options = options;
  }

  /**
   * キャッシュを取得
   */
  getCache(): IntegratedChartCache | null {
    return this.cache;
  }

  /**
   * チャートを描画
   */
  draw(events: StoredEvent[], screenshots: VerifyScreenshot[], drawOptions?: IntegratedChartDrawOptions): void {
    console.log('[IntegratedChart] draw called', {
      eventsCount: events?.length ?? 0,
      screenshotsCount: screenshots?.length ?? 0,
      startTimestamp: drawOptions?.startTimestamp,
    });

    // 既存のチャートを破棄
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }

    if (!events || events.length === 0) {
      return;
    }

    // データを準備
    this.cache = this.prepareData(events, screenshots, drawOptions?.startTimestamp ?? 0);

    // Chart.jsインスタンスを作成
    const config: ChartConfiguration = {
      type: 'line',
      data: {
        datasets: this.buildDatasets(),
      },
      options: this.buildChartOptions(),
    };

    this.chart = new Chart(this.options.canvas, config);
  }

  /**
   * データを準備
   */
  private prepareData(
    events: StoredEvent[],
    screenshots: VerifyScreenshot[],
    startTimestamp: number
  ): IntegratedChartCache {
    const totalTime = events[events.length - 1]?.timestamp ?? 0;

    // タイピング速度データ（5秒ウィンドウ）
    const typingSpeedData = this.calculateTypingSpeed(events, totalTime);

    // キーストロークダイナミクス
    const keystrokeData = this.extractKeystrokeData(events);

    // フォーカス・Visibilityイベント
    const focusEvents = events.filter((e) => e.type === 'focusChange');
    const visibilityEvents = events.filter((e) => e.type === 'visibilityChange');

    // 外部入力マーカー
    const externalInputMarkers = this.extractExternalInputMarkers(events);

    // イベントマッピング
    const eventData = events.map((e, index) => ({
      type: e.type,
      timestamp: e.timestamp,
      eventIndex: index,
      data: e.data,
    }));

    // 最大値を計算
    const maxSpeed = Math.ceil(
      Math.max(...typingSpeedData.map((d) => d.y), 1) * 1.2
    );
    const maxKeystrokeTime = Math.max(
      ...keystrokeData.dwell.map((d) => d.y),
      ...keystrokeData.flight.map((d) => d.y),
      300
    );

    return {
      totalTime,
      startTimestamp,
      events: eventData,
      screenshots,
      typingSpeedData,
      keystrokeData,
      focusEvents,
      visibilityEvents,
      externalInputMarkers,
      maxSpeed,
      maxKeystrokeTime: Math.ceil(maxKeystrokeTime / 100) * 100,
    };
  }

  /**
   * タイピング速度を計算
   */
  private calculateTypingSpeed(
    events: StoredEvent[],
    totalTime: number
  ): { x: number; y: number }[] {
    const windowSize = 5000; // 5秒ウィンドウ
    const data: { x: number; y: number }[] = [];

    for (let time = 0; time <= totalTime; time += 1000) {
      const windowStart = Math.max(0, time - windowSize);
      const windowEnd = time;

      let charCount = 0;
      for (const event of events) {
        if (event.timestamp >= windowStart && event.timestamp <= windowEnd) {
          if (
            event.type === 'contentChange' &&
            event.data &&
            event.inputType !== 'insertFromPaste' &&
            event.inputType !== 'insertFromDrop'
          ) {
            charCount += typeof event.data === 'string' ? event.data.length : 0;
          }
        }
      }

      const speed = charCount / (windowSize / 1000); // CPS
      data.push({ x: time, y: speed });
    }

    return data;
  }

  /**
   * キーストロークデータを抽出
   */
  private extractKeystrokeData(events: StoredEvent[]): {
    dwell: { x: number; y: number; key: string; eventIndex: number }[];
    flight: { x: number; y: number; key: string; eventIndex: number }[];
  } {
    const dwell: { x: number; y: number; key: string; eventIndex: number }[] = [];
    const flight: { x: number; y: number; key: string; eventIndex: number }[] = [];
    const MAX_VALID_TIME = 10000;

    events.forEach((event, index) => {
      const data = event.data as KeystrokeDynamicsData | null;
      if (!data || typeof data !== 'object') return;

      if (event.type === 'keyUp' && 'dwellTime' in data && data.dwellTime !== undefined) {
        if (data.dwellTime >= 0 && data.dwellTime <= MAX_VALID_TIME) {
          dwell.push({
            x: event.timestamp,
            y: data.dwellTime,
            key: data.key,
            eventIndex: index,
          });
        }
      }

      if (event.type === 'keyDown' && 'flightTime' in data && data.flightTime !== undefined) {
        if (data.flightTime >= 0 && data.flightTime <= MAX_VALID_TIME) {
          flight.push({
            x: event.timestamp,
            y: data.flightTime,
            key: data.key,
            eventIndex: index,
          });
        }
      }
    });

    return { dwell, flight };
  }

  /**
   * 外部入力マーカーを抽出
   */
  private extractExternalInputMarkers(events: StoredEvent[]): { timestamp: number; type: InputType }[] {
    const markers: { timestamp: number; type: InputType }[] = [];

    events.forEach((event) => {
      if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
        markers.push({
          timestamp: event.timestamp,
          type: event.inputType,
        });
      }
    });

    return markers;
  }

  /**
   * データセットを構築
   */
  private buildDatasets(): ChartDataset[] {
    if (!this.cache) return [];

    const datasets: ChartDataset[] = [];

    // 1. タイピング速度ライン
    datasets.push({
      type: 'line',
      label: 'タイピング速度 (CPS)',
      data: this.cache.typingSpeedData,
      borderColor: '#667eea',
      backgroundColor: 'rgba(102, 126, 234, 0.1)',
      fill: true,
      tension: 0.4,
      yAxisID: 'ySpeed',
      order: 3,
      pointRadius: 0,
      pointHoverRadius: 4,
    });

    // 2. Dwell Time散布図
    datasets.push({
      type: 'scatter',
      label: 'Dwell Time',
      data: this.cache.keystrokeData.dwell,
      backgroundColor: 'rgba(102, 126, 234, 0.6)',
      pointRadius: 2,
      pointHoverRadius: 4,
      yAxisID: 'yKeystroke',
      order: 4,
    });

    // 3. Flight Time散布図
    datasets.push({
      type: 'scatter',
      label: 'Flight Time',
      data: this.cache.keystrokeData.flight,
      backgroundColor: 'rgba(237, 100, 166, 0.6)',
      pointRadius: 2,
      pointHoverRadius: 4,
      yAxisID: 'yKeystroke',
      order: 4,
    });

    // 4. 外部入力マーカー
    if (this.cache.externalInputMarkers.length > 0) {
      datasets.push({
        type: 'scatter',
        label: '外部入力',
        data: this.cache.externalInputMarkers.map((m) => ({
          x: m.timestamp,
          y: 0,
        })),
        backgroundColor: 'rgba(255, 193, 7, 0.8)',
        pointRadius: 8,
        pointHoverRadius: 10,
        pointStyle: 'triangle',
        yAxisID: 'yEvents',
        order: 1,
      });
    }

    // 5. スクリーンショットポイント（検証状態別に分離）
    if (this.cache.screenshots.length > 0) {
      console.log('[IntegratedChart] Building screenshot datasets:', {
        total: this.cache.screenshots.length,
        details: this.cache.screenshots.map((s) => ({
          id: s.id,
          filename: s.filename,
          verified: s.verified,
          missing: s.missing,
          timestamp: s.timestamp,
        })),
      });

      // 検証済み（正常）
      const verifiedScreenshots = this.cache.screenshots.filter((s) => s.verified && !s.missing);
      console.log('[IntegratedChart] Verified screenshots:', verifiedScreenshots.length);
      if (verifiedScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: 'スクリーンショット (検証済み)',
          data: verifiedScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0,
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#22c55e';
            switch (data.screenshot.captureType) {
              case 'periodic':
                return '#3b82f6';
              case 'focusLost':
                return '#f59e0b';
              case 'manual':
                return '#10b981';
              default:
                return '#22c55e';
            }
          },
          borderColor: '#22c55e',
          borderWidth: 2,
          pointRadius: 10,
          pointHoverRadius: 14,
          yAxisID: 'yScreenshot',
          order: 0,
        });
      }

      // 欠損（画像ファイルがない）
      const missingScreenshots = this.cache.screenshots.filter((s) => s.missing);
      console.log('[IntegratedChart] Missing screenshots:', missingScreenshots.length);
      if (missingScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: 'スクリーンショット (欠損)',
          data: missingScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0,
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: 'rgba(239, 68, 68, 0.3)',
          borderColor: '#ef4444',
          borderWidth: 3,
          pointRadius: 10,
          pointHoverRadius: 14,
          pointStyle: 'crossRot',
          yAxisID: 'yScreenshot',
          order: 0,
        });
      }

      // 改ざんの可能性（画像はあるがハッシュ不一致）
      const tamperedScreenshots = this.cache.screenshots.filter((s) => !s.verified && !s.missing);
      console.log('[IntegratedChart] Tampered screenshots:', tamperedScreenshots.length);
      if (tamperedScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: 'スクリーンショット (改ざん)',
          data: tamperedScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0,
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: 'rgba(251, 191, 36, 0.5)',
          borderColor: '#f59e0b',
          borderWidth: 3,
          pointRadius: 10,
          pointHoverRadius: 14,
          pointStyle: 'triangle',
          yAxisID: 'yScreenshot',
          order: 0,
        });
      }
    }

    return datasets;
  }

  /**
   * チャートオプションを構築
   */
  private buildChartOptions(): ChartConfiguration['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false,
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: '時刻' },
          ticks: {
            callback: (value) => this.formatAxisTime(value as number),
            maxTicksLimit: 10,
          },
        },
        ySpeed: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'CPS' },
          beginAtZero: true,
          max: this.cache?.maxSpeed ?? 10,
          grid: {
            color: 'rgba(102, 126, 234, 0.1)',
          },
        },
        yKeystroke: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: 'ms' },
          beginAtZero: true,
          max: this.cache?.maxKeystrokeTime ?? 300,
          grid: {
            display: false,
          },
        },
        yScreenshot: {
          type: 'linear',
          display: false,
          min: -1,
          max: 1,
        },
        yEvents: {
          type: 'linear',
          display: false,
          min: -1,
          max: 1,
        },
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            boxWidth: 10,
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
          },
          pan: {
            enabled: true,
            mode: 'x',
          },
        },
        annotation: {
          annotations: this.buildAnnotations(),
        },
        tooltip: {
          callbacks: {
            label: (ctx) => this.formatTooltipLabel(ctx),
          },
        },
      },
      onClick: (event, elements) => this.handleClick(event, elements),
      onHover: (event, elements) => this.handleHover(event, elements),
    };
  }

  /**
   * アノテーションを構築（フォーカス状態バー）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildAnnotations(): Record<string, any> {
    if (!this.cache) return {};

    const annotations: Record<string, unknown> = {};

    // フォーカス喪失期間をハイライト
    // focusChange イベントの data.focused:
    //   - false: フォーカスを失った瞬間（この時点からフォーカス喪失期間開始）
    //   - true: フォーカスを取得した瞬間（この時点でフォーカス喪失期間終了）
    let unfocusedStartTime: number | null = null;
    let annotationIdx = 0;

    this.cache.focusEvents.forEach((event) => {
      const data = event.data as { focused: boolean } | null;
      if (!data) return;

      if (data.focused === false) {
        // フォーカスを失った → 喪失期間の開始
        unfocusedStartTime = event.timestamp;
      } else if (data.focused === true && unfocusedStartTime !== null) {
        // フォーカスを取得した → 喪失期間の終了
        annotations[`focus-lost-${annotationIdx++}`] = {
          type: 'box',
          xMin: unfocusedStartTime,
          xMax: event.timestamp,
          backgroundColor: 'rgba(254, 226, 226, 0.3)',
          borderWidth: 0,
        };
        unfocusedStartTime = null;
      }
    });

    // 最後の状態（フォーカスを失った状態で終わった場合）
    if (unfocusedStartTime !== null && this.cache.totalTime > unfocusedStartTime) {
      annotations['focus-lost-final'] = {
        type: 'box',
        xMin: unfocusedStartTime,
        xMax: this.cache.totalTime,
        backgroundColor: 'rgba(254, 226, 226, 0.3)',
        borderWidth: 0,
      };
    }

    // シークバーマーカー
    if (this.currentMarkerTimestamp !== null) {
      annotations['seekbar-marker'] = {
        type: 'line',
        xMin: this.currentMarkerTimestamp,
        xMax: this.currentMarkerTimestamp,
        borderColor: '#ef4444',
        borderWidth: 2,
        borderDash: [5, 5],
      };
    }

    return annotations;
  }

  /**
   * ツールチップラベルをフォーマット
   */
  private formatTooltipLabel(ctx: unknown): string {
    const context = ctx as { dataset: { label: string }; raw: unknown };
    const label = context.dataset.label;

    // スクリーンショット関連のラベル
    if (label.startsWith('スクリーンショット')) {
      const data = context.raw as ScreenshotPointData;
      const typeMap: Record<string, string> = {
        periodic: '定期',
        focusLost: 'フォーカス喪失',
        manual: '手動',
      };
      const captureType = typeMap[data.screenshot.captureType] ?? data.screenshot.captureType;
      const time = this.formatAxisTime(data.screenshot.timestamp);

      if (data.screenshot.missing) {
        return `❌ ${captureType} - ${time} [画像欠損]`;
      } else if (!data.screenshot.verified) {
        return `⚠️ ${captureType} - ${time} [改ざんの可能性]`;
      } else {
        return `📷 ${captureType} - ${time} [検証済み]`;
      }
    }

    if (label === 'タイピング速度 (CPS)') {
      const data = context.raw as { x: number; y: number };
      return `${data.y.toFixed(1)} CPS`;
    }

    if (label === 'Dwell Time' || label === 'Flight Time') {
      const data = context.raw as { x: number; y: number; key: string };
      return `${label}: ${data.y.toFixed(0)}ms (${data.key})`;
    }

    if (label === '外部入力') {
      return 'ペースト/ドロップ';
    }

    return label;
  }

  /**
   * スクリーンショット関連のデータセットかどうか判定
   */
  private isScreenshotDataset(label: string | undefined): boolean {
    return label?.startsWith('スクリーンショット') ?? false;
  }

  /**
   * クリックハンドラ
   */
  private handleClick(_event: unknown, elements: unknown[]): void {
    if (elements.length === 0) return;

    const element = elements[0] as { datasetIndex: number; index: number };
    const dataset = this.chart?.data.datasets[element.datasetIndex];

    if (this.isScreenshotDataset(dataset?.label)) {
      // スクリーンショットデータを取得（データポイントから直接）
      const dataPoint = dataset?.data[element.index] as ScreenshotPointData | undefined;
      if (dataPoint?.screenshot && this.options.onScreenshotClick) {
        this.options.onScreenshotClick(dataPoint.screenshot);
      }
      return;
    }

    // その他の場合は時間選択
    const data = dataset?.data[element.index] as { x: number } | undefined;
    if (data?.x !== undefined && this.options.onTimeSelect) {
      const eventIndex = this.findEventIndexAtTime(data.x);
      this.options.onTimeSelect(data.x, eventIndex);
    }
  }

  /**
   * ホバーハンドラ
   */
  private handleHover(event: unknown, elements: unknown[]): void {
    const nativeEvent = event as { native: MouseEvent };
    const screenshotElement = (elements as { datasetIndex: number; index: number }[]).find(
      (el) => {
        const dataset = this.chart?.data.datasets[el.datasetIndex];
        return this.isScreenshotDataset(dataset?.label);
      }
    );

    if (screenshotElement && this.options.onScreenshotHover) {
      const dataset = this.chart?.data.datasets[screenshotElement.datasetIndex];
      const dataPoint = dataset?.data[screenshotElement.index] as ScreenshotPointData | undefined;
      if (dataPoint?.screenshot) {
        this.options.onScreenshotHover(
          dataPoint.screenshot,
          nativeEvent.native.clientX,
          nativeEvent.native.clientY
        );
      }
    } else if (this.options.onScreenshotHover) {
      this.options.onScreenshotHover(null, 0, 0);
    }
  }

  /**
   * 時間に対応するイベントインデックスを検索
   */
  private findEventIndexAtTime(timestamp: number): number {
    if (!this.cache) return 0;

    for (let i = 0; i < this.cache.events.length; i++) {
      const event = this.cache.events[i];
      if (event && event.timestamp >= timestamp) {
        return i;
      }
    }
    return this.cache.events.length;
  }

  /**
   * 経過時間をフォーマット（mm:ss形式）
   */
  private formatElapsedTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * X軸の時刻をフォーマット（実時刻 HH:MM:SS または経過時間）
   */
  private formatAxisTime(elapsedMs: number): string {
    if (!this.cache || this.cache.startTimestamp === 0) {
      // 開始時刻が設定されていない場合は経過時間
      return this.formatElapsedTime(elapsedMs);
    }

    // 実時刻を計算
    const actualTime = new Date(this.cache.startTimestamp + elapsedMs);
    const hours = actualTime.getHours().toString().padStart(2, '0');
    const minutes = actualTime.getMinutes().toString().padStart(2, '0');
    const seconds = actualTime.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * シークバー位置にマーカーを表示
   */
  updateMarker(timestamp: number): void {
    this.currentMarkerTimestamp = timestamp;

    if (!this.chart) return;

    // アノテーションを更新
    const annotationPlugin = this.chart.options.plugins?.annotation;
    if (annotationPlugin) {
      (annotationPlugin as { annotations: Record<string, unknown> }).annotations =
        this.buildAnnotations();
      this.chart.update('none');
    }
  }

  /**
   * マーカーをクリア
   */
  clearMarker(): void {
    this.currentMarkerTimestamp = null;
    if (this.chart) {
      const annotationPlugin = this.chart.options.plugins?.annotation;
      if (annotationPlugin) {
        (annotationPlugin as { annotations: Record<string, unknown> }).annotations =
          this.buildAnnotations();
        this.chart.update('none');
      }
    }
  }

  /**
   * ズームをリセット
   */
  resetZoom(): void {
    if (this.chart) {
      (this.chart as unknown as { resetZoom: () => void }).resetZoom();
    }
  }

  /**
   * チャートを破棄
   */
  destroy(): void {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    this.cache = null;
  }

  /**
   * チャートを表示
   */
  show(): void {
    const parent = this.options.canvas.parentElement;
    if (parent) parent.style.display = 'block';
  }

  /**
   * チャートを非表示
   */
  hide(): void {
    const parent = this.options.canvas.parentElement;
    if (parent) parent.style.display = 'none';
  }
}
