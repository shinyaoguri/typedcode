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
import type { StoredEvent, KeystrokeDynamicsData, InputType, EventType } from '@typedcode/shared';
import type { VerifyScreenshot, IntegratedChartCache } from '../types.js';
import type { ChartEventVisibility } from '../types/chartVisibility.js';
import { DEFAULT_CHART_EVENT_VISIBILITY, isEventTypeVisible } from '../types/chartVisibility.js';
import { t } from '../i18n/index.js';

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
  private eventVisibility: ChartEventVisibility = { ...DEFAULT_CHART_EVENT_VISIBILITY };

  constructor(options: IntegratedChartOptions) {
    this.options = options;
  }

  /**
   * イベント可視性設定を更新
   */
  setEventVisibility(visibility: ChartEventVisibility): void {
    this.eventVisibility = visibility;
    // キャッシュとチャートが存在する場合は再描画
    if (this.cache && this.chart) {
      this.rebuildChart();
    }
  }

  /**
   * 現在のイベント可視性設定を取得
   */
  getEventVisibility(): ChartEventVisibility {
    return this.eventVisibility;
  }

  /**
   * チャートを再構築（可視性変更時など）
   */
  private rebuildChart(): void {
    if (!this.chart || !this.cache) return;

    // データセットを再構築
    this.chart.data.datasets = this.buildDatasets();

    // アノテーションを再構築
    const options = this.chart.options;
    if (options?.plugins?.annotation) {
      (options.plugins.annotation as { annotations: Record<string, unknown> }).annotations = this.buildAnnotations();
    }

    this.chart.update();
  }

  /**
   * イベントタイプが表示対象かどうかをチェック
   */
  private isVisible(eventType: EventType): boolean {
    return isEventTypeVisible(eventType, this.eventVisibility);
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

    // 内部ペーストマーカー
    const internalPasteMarkers = this.extractInternalPasteMarkers(events);

    // 人間検証イベント（humanAttestation）
    const humanAttestationEvents = this.extractHumanAttestationEvents(events);

    // 認証系イベント（termsAccepted, preExportAttestation）
    const authEvents = this.extractAuthEvents(events);

    // システムイベント（editorInitialized, networkStatusChange）
    const systemEvents = this.extractSystemEvents(events);

    // 実行イベント（codeExecution, terminalInput）
    const executionEvents = this.extractExecutionEvents(events);

    // キャプチャイベント（screenShareStart/Stop, templateInjection）
    const captureEvents = this.extractCaptureEvents(events);

    // ウィンドウイベント（windowResize）
    const windowResizeEvents = this.extractWindowResizeEvents(events);

    // コンテンツスナップショット
    const contentSnapshotEvents = this.extractContentSnapshotEvents(events);

    // イベントマッピング
    const eventData = events.map((e, index) => ({
      type: e.type,
      timestamp: e.timestamp,
      eventIndex: index,
      data: e.data,
    }));

    // 最大値を計算
    const maxSpeed = Math.ceil(Math.max(...typingSpeedData.map((d) => d.y), 1) * 1.2);
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
      internalPasteMarkers,
      humanAttestationEvents,
      authEvents,
      systemEvents,
      executionEvents,
      captureEvents,
      windowResizeEvents,
      contentSnapshotEvents,
      maxSpeed,
      maxKeystrokeTime: Math.ceil(maxKeystrokeTime / 100) * 100,
    };
  }

  /**
   * タイピング速度を計算
   */
  private calculateTypingSpeed(events: StoredEvent[], totalTime: number): { x: number; y: number }[] {
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
   * 内部ペーストマーカーを抽出
   */
  private extractInternalPasteMarkers(events: StoredEvent[]): { timestamp: number; eventIndex: number }[] {
    const markers: { timestamp: number; eventIndex: number }[] = [];

    events.forEach((event, index) => {
      if (event.inputType === 'insertFromInternalPaste') {
        markers.push({
          timestamp: event.timestamp,
          eventIndex: index,
        });
      }
    });

    return markers;
  }

  /**
   * 人間検証イベントを抽出
   */
  private extractHumanAttestationEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number }[] {
    const attestationEvents: { timestamp: number; eventIndex: number }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'humanAttestation') {
        attestationEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
        });
      }
    });

    return attestationEvents;
  }

  /**
   * 認証系イベントを抽出（termsAccepted, preExportAttestation）
   */
  private extractAuthEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number; type: string }[] {
    const authEvents: { timestamp: number; eventIndex: number; type: string }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'termsAccepted' || event.type === 'preExportAttestation') {
        authEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
          type: event.type,
        });
      }
    });

    return authEvents;
  }

  /**
   * システムイベントを抽出（editorInitialized, networkStatusChange）
   */
  private extractSystemEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number; type: string }[] {
    const systemEvents: { timestamp: number; eventIndex: number; type: string }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'editorInitialized' || event.type === 'networkStatusChange') {
        systemEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
          type: event.type,
        });
      }
    });

    return systemEvents;
  }

  /**
   * 実行イベントを抽出（codeExecution, terminalInput）
   */
  private extractExecutionEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number; type: string }[] {
    const executionEvents: { timestamp: number; eventIndex: number; type: string }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'codeExecution' || event.type === 'terminalInput') {
        executionEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
          type: event.type,
        });
      }
    });

    return executionEvents;
  }

  /**
   * キャプチャイベントを抽出（screenShareStart/Stop, templateInjection）
   */
  private extractCaptureEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number; type: string }[] {
    const captureEvents: { timestamp: number; eventIndex: number; type: string }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'screenShareStart' || event.type === 'screenShareStop' || event.type === 'templateInjection') {
        captureEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
          type: event.type,
        });
      }
    });

    return captureEvents;
  }

  /**
   * ウィンドウリサイズイベントを抽出
   */
  private extractWindowResizeEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number }[] {
    const resizeEvents: { timestamp: number; eventIndex: number }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'windowResize') {
        resizeEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
        });
      }
    });

    return resizeEvents;
  }

  /**
   * コンテンツスナップショットイベントを抽出
   */
  private extractContentSnapshotEvents(events: StoredEvent[]): { timestamp: number; eventIndex: number }[] {
    const snapshotEvents: { timestamp: number; eventIndex: number }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'contentSnapshot') {
        snapshotEvents.push({
          timestamp: event.timestamp,
          eventIndex: index,
        });
      }
    });

    return snapshotEvents;
  }

  /**
   * データセットを構築
   */
  private buildDatasets(): ChartDataset[] {
    if (!this.cache) return [];

    const datasets: ChartDataset[] = [];

    // 1. タイピング速度ライン（contentChangeに関連）
    if (this.isVisible('contentChange')) {
      datasets.push({
        type: 'line',
        label: t('charts.datasets.typingSpeed'),
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
    }

    // 2. Dwell Time散布図（keyUpに関連）
    if (this.isVisible('keyUp')) {
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
    }

    // 3. Flight Time散布図（keyDownに関連）
    if (this.isVisible('keyDown')) {
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
    }

    // 4. 外部入力マーカー（externalInputに関連）
    if (this.isVisible('externalInput') && this.cache.externalInputMarkers.length > 0) {
      datasets.push({
        type: 'scatter',
        label: t('charts.events.externalInput'),
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

    // 4.5. 内部ペーストマーカー（contentChangeに関連）
    if (this.isVisible('contentChange') && this.cache.internalPasteMarkers.length > 0) {
      datasets.push({
        type: 'scatter',
        label: t('charts.datasets.internalPaste'),
        data: this.cache.internalPasteMarkers.map((m) => ({
          x: m.timestamp,
          y: 0.35, // 外部入力マーカーより上、他のイベントより下に配置
        })),
        backgroundColor: '#22c55e', // 緑色（許可されたペースト）
        borderColor: '#16a34a',
        borderWidth: 2,
        pointRadius: 7,
        pointHoverRadius: 10,
        pointStyle: 'rectRounded', // 角丸四角で区別
        yAxisID: 'yTopMarkers',
        order: 1,
      });
    }

    // 5. 人間検証イベント（humanAttestationに関連）
    if (this.isVisible('humanAttestation') && this.cache.humanAttestationEvents.length > 0) {
      datasets.push({
        type: 'scatter',
        label: t('charts.datasets.humanAttestation'),
        data: this.cache.humanAttestationEvents.map((m) => ({
          x: m.timestamp,
          y: 0.9, // 上部に配置
        })),
        backgroundColor: '#8b5cf6', // 紫色
        borderColor: '#7c3aed',
        borderWidth: 2,
        pointRadius: 10,
        pointHoverRadius: 14,
        pointStyle: 'star', // 星形で人間検証を強調
        yAxisID: 'yTopMarkers',
        order: 0,
      });
    }

    // 6. スクリーンショットポイント（screenshotCaptureに関連）
    if (this.isVisible('screenshotCapture') && this.cache.screenshots.length > 0) {
      console.log('[IntegratedChart] Building screenshot datasets:', {
        total: this.cache.screenshots.length,
        details: this.cache.screenshots.map((s) => ({
          id: s.id,
          filename: s.filename,
          verified: s.verified,
          missing: s.missing,
          timestamp: s.timestamp,
          captureType: s.captureType,
        })),
      });

      // 定期撮影（periodic）- 上部に配置
      const periodicScreenshots = this.cache.screenshots.filter((s) => s.captureType === 'periodic');
      if (periodicScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.datasets.periodicCapture'),
          data: periodicScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0.6, // 上部に配置
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#3b82f6';
            if (data.screenshot.missing) return 'rgba(239, 68, 68, 0.3)';
            if (!data.screenshot.verified) return 'rgba(251, 191, 36, 0.5)';
            return '#3b82f6'; // 青
          },
          borderColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#2563eb';
            if (data.screenshot.missing) return '#ef4444';
            if (!data.screenshot.verified) return '#f59e0b';
            return '#2563eb';
          },
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (data?.screenshot?.missing) return 'crossRot';
            if (data?.screenshot && !data.screenshot.verified) return 'triangle';
            return 'circle';
          },
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // フォーカス喪失撮影（focusLost）- 定期撮影より少し下に配置
      const focusLostScreenshots = this.cache.screenshots.filter((s) => s.captureType === 'focusLost');
      if (focusLostScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.datasets.focusLostCapture'),
          data: focusLostScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0.3, // 定期撮影より下に配置
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#f59e0b';
            if (data.screenshot.missing) return 'rgba(239, 68, 68, 0.3)';
            if (!data.screenshot.verified) return 'rgba(251, 191, 36, 0.5)';
            return '#f59e0b'; // オレンジ
          },
          borderColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#d97706';
            if (data.screenshot.missing) return '#ef4444';
            if (!data.screenshot.verified) return '#f59e0b';
            return '#d97706';
          },
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (data?.screenshot?.missing) return 'crossRot';
            if (data?.screenshot && !data.screenshot.verified) return 'triangle';
            return 'rectRot'; // ひし形で区別
          },
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // 手動撮影（manual）- 最上部に配置
      const manualScreenshots = this.cache.screenshots.filter((s) => s.captureType === 'manual');
      if (manualScreenshots.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.datasets.manualCapture'),
          data: manualScreenshots.map((s) => ({
            x: s.timestamp,
            y: 0.9, // 最上部
            screenshot: s,
          })) as unknown as Point[],
          backgroundColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#10b981';
            if (data.screenshot.missing) return 'rgba(239, 68, 68, 0.3)';
            if (!data.screenshot.verified) return 'rgba(251, 191, 36, 0.5)';
            return '#10b981'; // 緑
          },
          borderColor: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (!data?.screenshot) return '#059669';
            if (data.screenshot.missing) return '#ef4444';
            if (!data.screenshot.verified) return '#f59e0b';
            return '#059669';
          },
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: (ctx) => {
            const data = ctx.raw as ScreenshotPointData | undefined;
            if (data?.screenshot?.missing) return 'crossRot';
            if (data?.screenshot && !data.screenshot.verified) return 'triangle';
            return 'rect'; // 四角で区別
          },
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }
    }

    // 7. 認証系イベント（termsAccepted, preExportAttestation）
    if (this.cache.authEvents && this.cache.authEvents.length > 0) {
      // termsAccepted
      const termsEvents = this.cache.authEvents.filter((e) => e.type === 'termsAccepted');
      if (this.isVisible('termsAccepted') && termsEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.termsAccepted'),
          data: termsEvents.map((m) => ({
            x: m.timestamp,
            y: 0.75,
          })),
          backgroundColor: '#22c55e', // 緑色
          borderColor: '#16a34a',
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: 'rectRounded',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // preExportAttestation
      const preExportEvents = this.cache.authEvents.filter((e) => e.type === 'preExportAttestation');
      if (this.isVisible('preExportAttestation') && preExportEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.datasets.preExportAttestation'),
          data: preExportEvents.map((m) => ({
            x: m.timestamp,
            y: 0.85,
          })),
          backgroundColor: '#a855f7', // 紫色
          borderColor: '#9333ea',
          borderWidth: 2,
          pointRadius: 10,
          pointHoverRadius: 14,
          pointStyle: 'star',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }
    }

    // 8. システムイベント（editorInitialized, networkStatusChange）
    if (this.cache.systemEvents && this.cache.systemEvents.length > 0) {
      // editorInitialized
      const initEvents = this.cache.systemEvents.filter((e) => e.type === 'editorInitialized');
      if (this.isVisible('editorInitialized') && initEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.editorInitialized'),
          data: initEvents.map((m) => ({
            x: m.timestamp,
            y: 0.1,
          })),
          backgroundColor: '#6b7280', // グレー
          borderColor: '#4b5563',
          borderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 10,
          pointStyle: 'circle',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // networkStatusChange
      const networkEvents = this.cache.systemEvents.filter((e) => e.type === 'networkStatusChange');
      if (this.isVisible('networkStatusChange') && networkEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.datasets.networkStatusChange'),
          data: networkEvents.map((m) => ({
            x: m.timestamp,
            y: 0.15,
          })),
          backgroundColor: '#0ea5e9', // スカイブルー
          borderColor: '#0284c7',
          borderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 10,
          pointStyle: 'triangle',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }
    }

    // 9. 実行イベント（codeExecution, terminalInput）
    if (this.cache.executionEvents && this.cache.executionEvents.length > 0) {
      // codeExecution
      const codeEvents = this.cache.executionEvents.filter((e) => e.type === 'codeExecution');
      if (this.isVisible('codeExecution') && codeEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.codeExecution'),
          data: codeEvents.map((m) => ({
            x: m.timestamp,
            y: 0.5,
          })),
          backgroundColor: '#f97316', // オレンジ
          borderColor: '#ea580c',
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: 'triangle',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // terminalInput
      const terminalEvents = this.cache.executionEvents.filter((e) => e.type === 'terminalInput');
      if (this.isVisible('terminalInput') && terminalEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.terminalInput'),
          data: terminalEvents.map((m) => ({
            x: m.timestamp,
            y: 0.45,
          })),
          backgroundColor: '#14b8a6', // ティール
          borderColor: '#0d9488',
          borderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 10,
          pointStyle: 'rect',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }
    }

    // 10. キャプチャイベント（screenShareStart/Stop, templateInjection）
    if (this.cache.captureEvents && this.cache.captureEvents.length > 0) {
      // screenShareStart
      const shareStartEvents = this.cache.captureEvents.filter((e) => e.type === 'screenShareStart');
      if (this.isVisible('screenShareStart') && shareStartEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.screenShareStart'),
          data: shareStartEvents.map((m) => ({
            x: m.timestamp,
            y: 0.55,
          })),
          backgroundColor: '#22c55e', // 緑
          borderColor: '#16a34a',
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: 'rectRot',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // screenShareStop
      const shareStopEvents = this.cache.captureEvents.filter((e) => e.type === 'screenShareStop');
      if (this.isVisible('screenShareStop') && shareStopEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.screenShareStop'),
          data: shareStopEvents.map((m) => ({
            x: m.timestamp,
            y: 0.55,
          })),
          backgroundColor: '#ef4444', // 赤
          borderColor: '#dc2626',
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: 'crossRot',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }

      // templateInjection
      const templateEvents = this.cache.captureEvents.filter((e) => e.type === 'templateInjection');
      if (this.isVisible('templateInjection') && templateEvents.length > 0) {
        datasets.push({
          type: 'scatter',
          label: t('charts.events.templateInjection'),
          data: templateEvents.map((m) => ({
            x: m.timestamp,
            y: 0.4,
          })),
          backgroundColor: '#f59e0b', // アンバー
          borderColor: '#d97706',
          borderWidth: 2,
          pointRadius: 8,
          pointHoverRadius: 12,
          pointStyle: 'rectRounded',
          yAxisID: 'yTopMarkers',
          order: 0,
        });
      }
    }

    // 11. ウィンドウリサイズ
    if (this.isVisible('windowResize') && this.cache.windowResizeEvents && this.cache.windowResizeEvents.length > 0) {
      datasets.push({
        type: 'scatter',
        label: t('charts.events.windowResize'),
        data: this.cache.windowResizeEvents.map((m) => ({
          x: m.timestamp,
          y: 0.2,
        })),
        backgroundColor: 'rgba(156, 163, 175, 0.6)', // グレー
        borderColor: '#9ca3af',
        borderWidth: 1,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointStyle: 'rect',
        yAxisID: 'yTopMarkers',
        order: 1,
      });
    }

    // 12. コンテンツスナップショット
    if (
      this.isVisible('contentSnapshot') &&
      this.cache.contentSnapshotEvents &&
      this.cache.contentSnapshotEvents.length > 0
    ) {
      datasets.push({
        type: 'scatter',
        label: t('charts.datasets.contentSnapshot'),
        data: this.cache.contentSnapshotEvents.map((m) => ({
          x: m.timestamp,
          y: 0.25,
        })),
        backgroundColor: 'rgba(139, 92, 246, 0.6)', // 薄い紫
        borderColor: '#8b5cf6',
        borderWidth: 1,
        pointRadius: 5,
        pointHoverRadius: 8,
        pointStyle: 'circle',
        yAxisID: 'yTopMarkers',
        order: 1,
      });
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
          title: { display: true, text: t('charts.axisTime') },
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
        yTopMarkers: {
          type: 'linear',
          display: false,
          min: 0,
          max: 1,
          // 上部に配置するためのスケール
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
          limits: {
            x: {
              min: 0,
              max: this.cache?.totalTime ?? 0,
            },
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
   * アノテーションを構築（フォーカス状態・Visibility状態のバー）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildAnnotations(): Record<string, any> {
    if (!this.cache) return {};

    const annotations: Record<string, unknown> = {};
    let annotationIdx = 0;

    // ============================================
    // フォーカス喪失期間をハイライト（赤系）（focusChangeに関連）
    // focusChange イベントの data.focused:
    //   - false: フォーカスを失った瞬間（この時点からフォーカス喪失期間開始）
    //   - true: フォーカスを取得した瞬間（この時点でフォーカス喪失期間終了）
    // ============================================
    if (this.isVisible('focusChange')) {
      let unfocusedStartTime: number | null = null;

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
            yMin: 0.85, // 上部に薄いバーとして表示
            yMax: 0.95,
            yScaleID: 'yTopMarkers',
            backgroundColor: 'rgba(239, 68, 68, 0.4)', // 赤系
            borderColor: 'rgba(239, 68, 68, 0.8)',
            borderWidth: 1,
            label: {
              display: false,
            },
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
          yMin: 0.85,
          yMax: 0.95,
          yScaleID: 'yTopMarkers',
          backgroundColor: 'rgba(239, 68, 68, 0.4)',
          borderColor: 'rgba(239, 68, 68, 0.8)',
          borderWidth: 1,
        };
      }
    }

    // ============================================
    // Visibility喪失期間（タブ非アクティブ）をハイライト（グレー系）（visibilityChangeに関連）
    // visibilityChange イベントの data.visible:
    //   - false: タブが非アクティブになった瞬間
    //   - true: タブがアクティブになった瞬間
    // ============================================
    if (this.isVisible('visibilityChange')) {
      let hiddenStartTime: number | null = null;

      this.cache.visibilityEvents.forEach((event) => {
        const data = event.data as { visible: boolean } | null;
        if (!data) return;

        if (data.visible === false) {
          // タブが非アクティブになった → 非表示期間の開始
          hiddenStartTime = event.timestamp;
        } else if (data.visible === true && hiddenStartTime !== null) {
          // タブがアクティブになった → 非表示期間の終了
          annotations[`visibility-hidden-${annotationIdx++}`] = {
            type: 'box',
            xMin: hiddenStartTime,
            xMax: event.timestamp,
            yMin: 0.73, // フォーカスバーの下に配置
            yMax: 0.83,
            yScaleID: 'yTopMarkers',
            backgroundColor: 'rgba(107, 114, 128, 0.4)', // グレー系
            borderColor: 'rgba(107, 114, 128, 0.8)',
            borderWidth: 1,
          };
          hiddenStartTime = null;
        }
      });

      // 最後の状態（非アクティブ状態で終わった場合）
      if (hiddenStartTime !== null && this.cache.totalTime > hiddenStartTime) {
        annotations['visibility-hidden-final'] = {
          type: 'box',
          xMin: hiddenStartTime,
          xMax: this.cache.totalTime,
          yMin: 0.73,
          yMax: 0.83,
          yScaleID: 'yTopMarkers',
          backgroundColor: 'rgba(107, 114, 128, 0.4)',
          borderColor: 'rgba(107, 114, 128, 0.8)',
          borderWidth: 1,
        };
      }
    }

    // ============================================
    // シークバーマーカー
    // ============================================
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

    // スクリーンショット関連のラベル（定期撮影、フォーカス喪失撮影、手動撮影）
    if (this.isScreenshotDataset(label)) {
      const data = context.raw as ScreenshotPointData;
      const typeMap: Record<string, string> = {
        periodic: t('screenshot.typePeriodic'),
        focusLost: t('screenshot.typeFocusLost'),
        manual: t('screenshot.typeManual'),
      };
      const type = typeMap[data.screenshot.captureType] ?? data.screenshot.captureType;
      const time = this.formatAxisTime(data.screenshot.timestamp);

      if (data.screenshot.missing) {
        return t('charts.tooltips.screenshotMissing', { type, time });
      } else if (!data.screenshot.verified) {
        return t('charts.tooltips.screenshotTampered', { type, time });
      } else {
        return t('charts.tooltips.screenshotVerified', { type, time });
      }
    }

    if (label === t('charts.datasets.humanAttestation')) {
      const data = context.raw as { x: number; y: number };
      return t('charts.tooltips.humanAttestation', { time: this.formatAxisTime(data.x) });
    }

    if (label === t('charts.datasets.typingSpeed')) {
      const data = context.raw as { x: number; y: number };
      return `${data.y.toFixed(1)} CPS`;
    }

    if (label === 'Dwell Time' || label === 'Flight Time') {
      const data = context.raw as { x: number; y: number; key: string };
      return `${label}: ${data.y.toFixed(0)}ms (${data.key})`;
    }

    if (label === t('charts.events.externalInput')) {
      return t('charts.tooltips.externalInput');
    }

    if (label === t('charts.datasets.internalPaste')) {
      const data = context.raw as { x: number; y: number };
      return t('charts.tooltips.internalPaste', { time: this.formatAxisTime(data.x) });
    }

    // Auth / system / execution / capture / window / content events は
    // dataset label → tooltip キーの対応表で解決する
    const eventTooltips: Array<[string, string]> = [
      [t('charts.events.termsAccepted'), 'charts.tooltips.termsAccepted'],
      [t('charts.datasets.preExportAttestation'), 'charts.tooltips.preExportAttestation'],
      [t('charts.events.editorInitialized'), 'charts.tooltips.editorInitialized'],
      [t('charts.datasets.networkStatusChange'), 'charts.tooltips.networkStatusChange'],
      [t('charts.events.codeExecution'), 'charts.tooltips.codeExecution'],
      [t('charts.events.terminalInput'), 'charts.tooltips.terminalInput'],
      [t('charts.events.screenShareStart'), 'charts.tooltips.screenShareStart'],
      [t('charts.events.screenShareStop'), 'charts.tooltips.screenShareStop'],
      [t('charts.events.templateInjection'), 'charts.tooltips.templateInjection'],
      [t('charts.events.windowResize'), 'charts.tooltips.windowResize'],
      [t('charts.datasets.contentSnapshot'), 'charts.tooltips.contentSnapshot'],
    ];
    const match = eventTooltips.find(([datasetLabel]) => datasetLabel === label);
    if (match) {
      const data = context.raw as { x: number; y: number };
      return t(match[1], { time: this.formatAxisTime(data.x) });
    }

    return label;
  }

  /**
   * スクリーンショット関連のデータセットかどうか判定
   */
  private isScreenshotDataset(label: string | undefined): boolean {
    if (!label) return false;
    // 新しいラベル形式（定期撮影、フォーカス喪失撮影、手動撮影）
    return (
      label === t('charts.datasets.periodicCapture') ||
      label === t('charts.datasets.focusLostCapture') ||
      label === t('charts.datasets.manualCapture') ||
      // 後方互換のための旧ラベル
      label.startsWith('スクリーンショット')
    );
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
    const screenshotElement = (elements as { datasetIndex: number; index: number }[]).find((el) => {
      const dataset = this.chart?.data.datasets[el.datasetIndex];
      return this.isScreenshotDataset(dataset?.label);
    });

    if (screenshotElement && this.options.onScreenshotHover) {
      const dataset = this.chart?.data.datasets[screenshotElement.datasetIndex];
      const dataPoint = dataset?.data[screenshotElement.index] as ScreenshotPointData | undefined;
      if (dataPoint?.screenshot) {
        this.options.onScreenshotHover(dataPoint.screenshot, nativeEvent.native.clientX, nativeEvent.native.clientY);
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
      (annotationPlugin as { annotations: Record<string, unknown> }).annotations = this.buildAnnotations();
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
        (annotationPlugin as { annotations: Record<string, unknown> }).annotations = this.buildAnnotations();
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
