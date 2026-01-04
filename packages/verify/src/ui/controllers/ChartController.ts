/**
 * ChartController - チャート管理を担当するコントローラー
 */
import { TimelineChart } from '../../charts/TimelineChart';
import { MouseChart } from '../../charts/MouseChart';
import { IntegratedChart } from '../../charts/IntegratedChart';
import { ScreenshotOverlay } from '../../charts/ScreenshotOverlay';
import { SeekbarController } from '../../charts/SeekbarController';
import { ScreenshotLightbox } from '../ScreenshotLightbox';
import { ScreenshotService } from '../../services/ScreenshotService';

export interface ChartControllerState {
  timelineChart: TimelineChart | null;
  mouseChart: MouseChart | null;
  integratedChart: IntegratedChart | null;
  screenshotOverlay: ScreenshotOverlay | null;
  screenshotLightbox: ScreenshotLightbox | null;
  seekbarController: SeekbarController | null;
  screenshotService: ScreenshotService | null;
}

export class ChartController {
  private timelineChart: TimelineChart | null = null;
  private mouseChart: MouseChart | null = null;
  private integratedChart: IntegratedChart | null = null;
  private screenshotOverlay: ScreenshotOverlay | null = null;
  private screenshotLightbox: ScreenshotLightbox | null = null;
  private seekbarController: SeekbarController | null = null;
  private screenshotService: ScreenshotService | null = null;

  /**
   * チャートを初期化
   */
  initialize(callbacks?: {
    onSeek?: (eventIndex: number) => void;
  }): void {
    const timelineCanvas = document.getElementById('integrated-timeline-chart') as HTMLCanvasElement;
    const mouseCanvas = document.getElementById('mouse-trajectory-chart') as HTMLCanvasElement;
    const integratedCanvas = document.getElementById('integrated-chart') as HTMLCanvasElement;

    // 既存のTimelineChart/MouseChart（後方互換性）
    if (timelineCanvas) {
      this.timelineChart = new TimelineChart({ canvas: timelineCanvas });
    }

    if (mouseCanvas) {
      this.mouseChart = new MouseChart({ canvas: mouseCanvas });
    }

    // IntegratedChart (Chart.js) を初期化
    if (integratedCanvas) {
      // ScreenshotServiceを先に初期化
      this.screenshotService = new ScreenshotService();

      // ScreenshotOverlay (ホバープレビュー)
      this.screenshotOverlay = new ScreenshotOverlay(this.screenshotService);

      // ScreenshotLightbox
      this.screenshotLightbox = new ScreenshotLightbox({
        screenshotService: this.screenshotService,
        onNavigate: (screenshot) => {
          // ライトボックスでナビゲート時、チャートマーカーを更新
          if (this.integratedChart) {
            this.integratedChart.updateMarker(screenshot.timestamp);
          }
        },
      });

      // IntegratedChart
      this.integratedChart = new IntegratedChart({
        canvas: integratedCanvas,
        onScreenshotHover: (screenshot, x, y) => {
          if (screenshot && this.screenshotOverlay) {
            this.screenshotOverlay.show(screenshot, x, y);
          } else if (this.screenshotOverlay) {
            this.screenshotOverlay.hide();
          }
        },
        onScreenshotClick: (screenshot) => {
          if (this.screenshotLightbox) {
            this.screenshotLightbox.open(screenshot);
          }
        },
        onTimeSelect: (timestamp, _eventIndex) => {
          // シークバーと連携
          if (this.seekbarController) {
            this.seekbarController.seekToTime(timestamp);
          }
        },
      });

      // SeekbarControllerにIntegratedChartを連携
      if (this.seekbarController) {
        this.seekbarController.setIntegratedChart(this.integratedChart);
      }
    }

    // SeekbarController を初期化
    const codePreview = document.querySelector('#code-preview code') as HTMLElement | null;
    this.seekbarController = new SeekbarController(
      {
        floatingSeekbar: document.getElementById('chart-seekbar'),
        slider: document.getElementById('seekbar-slider') as HTMLInputElement | null,
        progressBar: document.getElementById('seekbar-progress'),
        timeDisplay: document.getElementById('seekbar-time'),
        eventCountDisplay: document.getElementById('seekbar-event-count'),
        startButton: document.getElementById('seekbar-start'),
        prevButton: document.getElementById('seekbar-prev'),
        playButton: document.getElementById('seekbar-play'),
        playIcon: document.getElementById('play-icon'),
        nextButton: document.getElementById('seekbar-next'),
        endButton: document.getElementById('seekbar-end'),
        contentPreview: codePreview,
      },
      {
        onSeek: (eventIndex) => {
          callbacks?.onSeek?.(eventIndex);
        },
      }
    );
    this.seekbarController.setupEventListeners();

    // IntegratedChartが既に存在する場合は連携
    if (this.integratedChart) {
      this.seekbarController.setIntegratedChart(this.integratedChart);
    }
  }

  /**
   * スクリーンショットサービスを更新し、関連コンポーネントに伝播
   * ZIP/フォルダ両方の読み込みパスで一貫した動作を保証
   */
  updateScreenshotService(screenshotService: ScreenshotService): void {
    // 古いサービスを破棄
    if (this.screenshotService) {
      this.screenshotService.dispose();
    }

    this.screenshotService = screenshotService;

    // ScreenshotOverlay を再作成
    if (this.screenshotOverlay) {
      this.screenshotOverlay.destroy();
    }
    this.screenshotOverlay = new ScreenshotOverlay(this.screenshotService);

    // ScreenshotLightbox を再作成
    if (this.screenshotLightbox) {
      this.screenshotLightbox.destroy();
    }
    this.screenshotLightbox = new ScreenshotLightbox({
      screenshotService: this.screenshotService,
      onNavigate: (screenshot) => {
        if (this.integratedChart) {
          this.integratedChart.updateMarker(screenshot.timestamp);
        }
      },
    });
  }

  // Getters
  getTimelineChart(): TimelineChart | null {
    return this.timelineChart;
  }

  getMouseChart(): MouseChart | null {
    return this.mouseChart;
  }

  getIntegratedChart(): IntegratedChart | null {
    return this.integratedChart;
  }

  getScreenshotOverlay(): ScreenshotOverlay | null {
    return this.screenshotOverlay;
  }

  getScreenshotLightbox(): ScreenshotLightbox | null {
    return this.screenshotLightbox;
  }

  getSeekbarController(): SeekbarController | null {
    return this.seekbarController;
  }

  getScreenshotService(): ScreenshotService | null {
    return this.screenshotService;
  }
}
