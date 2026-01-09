/**
 * ScreenshotTracker - スクリーンショットイベントの追跡
 * ScreenCaptureServiceとScreenshotStorageServiceを統合し、
 * ハッシュチェーンへのイベント記録を管理
 */

import type {
  ScreenshotCaptureData,
  ScreenshotCaptureType,
  DisplayInfo,
  ScreenShareStartData,
  ScreenShareStopData,
} from '@typedcode/shared';
import {
  ScreenCaptureService,
  type ScreenCaptureOptions,
} from '../services/ScreenCaptureService.js';
import { ScreenshotStorageService } from '../services/ScreenshotStorageService.js';
import type { SessionStorageService } from '../services/SessionStorageService.js';
import { ScreenShareGuide } from '../ui/components/ScreenShareGuide.js';
import { t } from '../i18n/index.js';

/** スクリーンショット撮影イベント */
export interface ScreenshotCaptureEvent {
  type: 'screenshotCapture';
  data: ScreenshotCaptureData;
  description: string;
}

/** 画面共有開始イベント */
export interface ScreenShareStartEvent {
  type: 'screenShareStart';
  data: ScreenShareStartData;
  description: string;
}

/** 画面共有停止イベント */
export interface ScreenShareStopEvent {
  type: 'screenShareStop';
  data: ScreenShareStopData;
  description: string;
}

/** スクリーンショットトラッカーイベント（全種類） */
export type ScreenshotTrackerEvent =
  | ScreenshotCaptureEvent
  | ScreenShareStartEvent
  | ScreenShareStopEvent;

/** スクリーンショットトラッカーコールバック */
export type ScreenshotTrackerCallback = (event: ScreenshotTrackerEvent) => void;

/** ストリーム停止時のコールバック */
export type StreamStoppedCallback = () => void;

/** スクリーンショットトラッカーオプション */
export interface ScreenshotTrackerOptions {
  /** 定期キャプチャ間隔（ミリ秒） */
  periodicIntervalMs?: number;
  /** フォーカス喪失後のキャプチャ遅延（ミリ秒） */
  focusLostDelayMs?: number;
  /** JPEG品質 (0-1) */
  jpegQuality?: number;
}

export class ScreenshotTracker {
  private captureService: ScreenCaptureService;
  private storageService: ScreenshotStorageService;
  private screenShareGuide: ScreenShareGuide;
  private callback: ScreenshotTrackerCallback | null = null;
  private streamStoppedCallback: StreamStoppedCallback | null = null;
  private attached = false;
  private lastEventSequence = 0;
  private initialized = false;
  private shareStartTimestamp: number | null = null;
  private currentDisplayInfo: DisplayInfo | null = null;
  private currentDisplaySurface: string | null = null;
  private proofStartTime: number = 0; // TypingProofの開始時刻（相対時間計算用）
  private captureEnabled = true; // キャプチャ保存が有効かどうか（タブがない場合は無効）

  constructor(sessionService: SessionStorageService, options?: ScreenshotTrackerOptions) {
    const captureOptions: ScreenCaptureOptions = {
      periodicIntervalMs: options?.periodicIntervalMs,
      focusLostDelayMs: options?.focusLostDelayMs,
      jpegQuality: options?.jpegQuality,
    };

    this.captureService = new ScreenCaptureService(captureOptions);
    this.storageService = new ScreenshotStorageService(sessionService);
    this.screenShareGuide = new ScreenShareGuide();
  }

  /**
   * セッションIDを設定（ScreenshotStorageServiceに委譲）
   */
  setSessionId(sessionId: string): void {
    this.storageService.setSessionId(sessionId);
  }

  // ========================================
  // 静的メソッド
  // ========================================

  /**
   * Screen Capture APIがサポートされているかチェック
   */
  static isSupported(): boolean {
    return ScreenCaptureService.isSupported();
  }

  /**
   * ストレージサービスを取得（LogViewerでのプレビュー用）
   */
  getStorageService(): ScreenshotStorageService {
    return this.storageService;
  }

  // ========================================
  // コールバック設定
  // ========================================

  /**
   * コールバックを設定
   */
  setCallback(callback: ScreenshotTrackerCallback): void {
    this.callback = callback;
  }

  /**
   * ストリーム停止時のコールバックを設定
   */
  setStreamStoppedCallback(callback: StreamStoppedCallback): void {
    this.streamStoppedCallback = callback;
    // ScreenCaptureServiceにも設定
    this.captureService.setStreamEndedCallback(() => {
      // 停止イベントを発火
      this.emitScreenShareStopEvent('stream_ended');
      this.attached = false;
      callback();
    });
  }

  /**
   * キャプチャ保存の有効/無効を設定
   * タブがない場合は無効にして、不要なスクリーンショット保存を防ぐ
   */
  setCaptureEnabled(enabled: boolean): void {
    this.captureEnabled = enabled;
    console.log(`[ScreenshotTracker] Capture ${enabled ? 'enabled' : 'disabled'}`);
  }

  // ========================================
  // ライフサイクル
  // ========================================

  /**
   * 許可を要求してトラッキングを開始
   * @param requireMonitor trueの場合、画面全体(monitor)のみを許可
   * @returns 結果オブジェクト { success, error?, displaySurface? }
   */
  async requestPermissionAndAttach(requireMonitor = true): Promise<{
    success: boolean;
    error?: string;
    displaySurface?: string;
  }> {
    if (this.attached) {
      return { success: true };
    }

    // ストレージを初期化
    // 注: スクリーンショットはセッションDBに統合されているため、
    // sessionIdでフィルタリングされ、セッションごとに分離されている
    try {
      await this.storageService.initialize();
      const existingCount = await this.storageService.count();
      console.log(`[ScreenshotTracker] Storage initialized, ${existingCount} existing screenshots`);
    } catch (error) {
      console.error('[ScreenshotTracker] Failed to initialize storage:', error);
      return { success: false, error: 'storage_init_failed' };
    }

    // 権限を要求
    const result = await this.captureService.requestPermission(requireMonitor);
    if (!result.granted) {
      console.warn('[ScreenshotTracker] Permission not granted:', result.error);
      // エラーダイアログは呼び出し元(ScreenCaptureDialogs)で表示される
      return {
        success: false,
        error: result.error,
        displaySurface: result.displaySurface,
      };
    }

    // キャプチャコールバックを設定
    this.captureService.setCallback(
      (imageBlob, imageHash, captureType, displayInfo) => {
        // displayInfoを保存（停止イベント用）
        this.currentDisplayInfo = displayInfo;
        this.handleCapture(imageBlob, imageHash, captureType, displayInfo);
      }
    );

    // ストリーム停止コールバックを再設定（requestPermission後に必要）
    if (this.streamStoppedCallback) {
      this.captureService.setStreamEndedCallback(() => {
        // 停止イベントを発火
        this.emitScreenShareStopEvent('stream_ended');
        this.attached = false;
        this.streamStoppedCallback?.();
      });
    }

    // 定期キャプチャを開始
    this.captureService.startPeriodicCapture();

    // 再開（resume）かどうかを判定（既にセッションが開始されていた場合）
    const isResume = this.initialized;

    this.attached = true;
    this.initialized = true;

    // 画面共有開始時刻とdisplaySurfaceを記録
    this.shareStartTimestamp = performance.now();
    this.currentDisplaySurface = result.displaySurface ?? 'unknown';

    // 初期displayInfoを設定（キャプチャ前に開始イベントを発火するため）
    this.currentDisplayInfo = {
      width: window.screen.width,
      height: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      displaySurface: result.displaySurface,
    };

    // 画面共有開始/再開イベントを発火
    if (isResume) {
      this.emitScreenShareResumedEvent();
    } else {
      this.emitScreenShareStartEvent();
    }

    // Chrome共有ダイアログの「非表示」ボタンを押すよう促すガイドを表示
    this.screenShareGuide.show();

    console.log(`[ScreenshotTracker] ${isResume ? 'Resumed' : 'Attached'} and started`);

    return { success: true, displaySurface: result.displaySurface };
  }

  /**
   * トラッキングを停止
   */
  detach(): void {
    if (!this.attached) return;

    this.captureService.stopPeriodicCapture();
    this.attached = false;
    console.log('[ScreenshotTracker] Detached');
  }

  /**
   * 許可状態を取得
   */
  getPermissionState() {
    return this.captureService.getPermissionState();
  }

  // ========================================
  // フォーカスイベント連携
  // ========================================

  /**
   * フォーカス喪失を通知（VisibilityTrackerから呼び出される）
   */
  notifyFocusLost(): void {
    if (this.attached) {
      this.captureService.handleFocusLost();
    }
  }

  /**
   * フォーカス復帰を通知
   */
  notifyFocusRegained(): void {
    if (this.attached) {
      this.captureService.handleFocusRegained();
    }
  }

  // ========================================
  // イベントシーケンス管理
  // ========================================

  /**
   * 現在のイベントシーケンスを設定
   * キャプチャ時に対応するハッシュチェーンイベントと紐付けるため
   */
  setLastEventSequence(sequence: number): void {
    this.lastEventSequence = sequence;
  }

  /**
   * TypingProofの開始時刻を設定
   * スクリーンショットのタイムスタンプをハッシュチェーンと同じ相対時間で記録するため
   */
  setProofStartTime(startTime: number): void {
    this.proofStartTime = startTime;
  }

  // ========================================
  // エクスポート
  // ========================================

  /**
   * 全スクリーンショットをエクスポート用に取得
   */
  async getScreenshotsForExport(): Promise<Map<string, Blob>> {
    return this.storageService.getAllForExport();
  }

  /**
   * エクスポート用のマニフェストを生成
   */
  async getManifestForExport(): Promise<object[]> {
    return this.storageService.generateManifest();
  }

  /**
   * スクリーンショット数を取得
   */
  async getScreenshotCount(): Promise<number> {
    return this.storageService.count();
  }

  // ========================================
  // 内部メソッド
  // ========================================

  /**
   * キャプチャ完了時のハンドラ
   */
  private async handleCapture(
    imageBlob: Blob,
    imageHash: string,
    captureType: ScreenshotCaptureType,
    displayInfo: DisplayInfo
  ): Promise<void> {
    // キャプチャ保存が無効の場合はスキップ（タブがない場合など）
    if (!this.captureEnabled) {
      console.debug('[ScreenshotTracker] Capture skipped - capture disabled');
      return;
    }

    // TypingProofと同じ相対時間を使用（performance.now() - startTime）
    const timestamp = performance.now() - this.proofStartTime;
    const createdAt = Date.now();

    // ストレージに保存
    try {
      const storageKey = await this.storageService.save({
        imageHash,
        imageBlob,
        captureType,
        timestamp,
        createdAt,
        displayInfo,
        eventSequence: this.lastEventSequence,
      });

      // イベントデータを作成
      const eventData: ScreenshotCaptureData = {
        imageHash,
        captureType,
        timestamp,
        displayInfo,
        storageKey,
        fileSizeBytes: imageBlob.size,
      };

      // 説明文を生成
      const description = this.generateDescription(captureType);

      // コールバックを呼び出し
      console.log(`[ScreenshotTracker] callback is ${this.callback ? 'set' : 'null'}`);
      if (this.callback) {
        this.callback({
          type: 'screenshotCapture',
          data: eventData,
          description,
        });
      }

      console.log(`[ScreenshotTracker] Screenshot recorded: ${captureType}`);
    } catch (error) {
      console.error('[ScreenshotTracker] Failed to save screenshot:', error);
    }
  }

  /**
   * キャプチャタイプに応じた説明文を生成
   */
  private generateDescription(captureType: ScreenshotCaptureType): string {
    switch (captureType) {
      case 'periodic':
        return t('screenCapture.capturedPeriodic') ?? 'Periodic screenshot captured';
      case 'focusLost':
        return t('screenCapture.capturedFocusLost') ?? 'Screenshot captured after focus lost';
      case 'manual':
        return t('screenCapture.capturedManual') ?? 'Manual screenshot captured';
      default:
        return t('screenCapture.captured') ?? 'Screenshot captured';
    }
  }

  /**
   * 画面共有開始イベントを発火
   */
  private emitScreenShareStartEvent(): void {
    if (!this.callback || !this.currentDisplayInfo) return;

    // TypingProofと同じ相対時間を使用
    const relativeTimestamp = this.shareStartTimestamp !== null
      ? this.shareStartTimestamp - this.proofStartTime
      : performance.now() - this.proofStartTime;

    const data: ScreenShareStartData = {
      displaySurface: this.currentDisplaySurface ?? 'unknown',
      displayInfo: this.currentDisplayInfo,
      timestamp: relativeTimestamp,
    };

    const description = t('events.screenShareStart') ?? 'Screen sharing started';

    this.callback({
      type: 'screenShareStart',
      data,
      description,
    });

    console.log('[ScreenshotTracker] Screen share start event emitted');
  }

  /**
   * 画面共有再開イベントを発火
   */
  private emitScreenShareResumedEvent(): void {
    if (!this.callback || !this.currentDisplayInfo) return;

    // TypingProofと同じ相対時間を使用
    const relativeTimestamp = this.shareStartTimestamp !== null
      ? this.shareStartTimestamp - this.proofStartTime
      : performance.now() - this.proofStartTime;

    const data: ScreenShareStartData = {
      displaySurface: this.currentDisplaySurface ?? 'unknown',
      displayInfo: this.currentDisplayInfo,
      timestamp: relativeTimestamp,
    };

    const description = t('events.screenShareResumed') ?? 'Screen sharing resumed';

    this.callback({
      type: 'screenShareStart', // 既存の型を再利用（データ構造は同じ）
      data,
      description,
    });

    console.log('[ScreenshotTracker] Screen share resumed event emitted');
  }

  /**
   * 画面共有停止イベントを発火
   */
  private emitScreenShareStopEvent(
    reason: 'user_stopped' | 'stream_ended' | 'error'
  ): void {
    if (!this.callback) return;

    const now = performance.now();
    const duration = this.shareStartTimestamp
      ? now - this.shareStartTimestamp
      : 0;

    // TypingProofと同じ相対時間を使用
    const data: ScreenShareStopData = {
      reason,
      timestamp: now - this.proofStartTime,
      duration,
    };

    const description = t('events.screenShareStop') ?? 'Screen sharing stopped';

    this.callback({
      type: 'screenShareStop',
      data,
      description,
    });

    // 状態をリセット
    this.shareStartTimestamp = null;

    console.log(`[ScreenshotTracker] Screen share stop event emitted: ${reason}, duration: ${duration}ms`);
  }

  // ========================================
  // リソース管理
  // ========================================

  /**
   * ストレージをクリア
   */
  async clearStorage(): Promise<void> {
    await this.storageService.clear();
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.captureService.dispose();
    this.storageService.close();
    this.screenShareGuide.hide();
    this.callback = null;
    this.initialized = false;
    console.log('[ScreenshotTracker] Disposed');
  }
}
