/**
 * ScreenCaptureService - Screen Capture API管理
 * 画面キャプチャの取得、権限管理、ストリーム管理を担当
 */

import type {
  ScreenshotCaptureType,
  DisplayInfo,
  ScreenCapturePermissionState,
} from '@typedcode/shared';

/** Screen Captureオプション */
export interface ScreenCaptureOptions {
  /** JPEG品質 (0-1) デフォルト: 0.4 */
  jpegQuality?: number;
  /** 定期キャプチャ間隔（ミリ秒） デフォルト: 30000 (30秒) */
  periodicIntervalMs?: number;
  /** フォーカス喪失後の最初のキャプチャ遅延（ミリ秒） デフォルト: 5000 (5秒) */
  focusLostDelayMs?: number;
  /** フォーカス喪失中のキャプチャ間隔（ミリ秒） デフォルト: 5000 (5秒) */
  focusLostIntervalMs?: number;
}

/** キャプチャ結果 */
export interface CaptureResult {
  success: boolean;
  imageBlob?: Blob;
  imageHash?: string;
  displayInfo?: DisplayInfo;
  error?: string;
}

/** キャプチャコールバック */
export type ScreenCaptureCallback = (
  imageBlob: Blob,
  imageHash: string,
  captureType: ScreenshotCaptureType,
  displayInfo: DisplayInfo
) => void;

/** ストリーム停止コールバック */
export type StreamEndedCallback = () => void;

/** デフォルト設定 */
const DEFAULT_OPTIONS: Required<ScreenCaptureOptions> = {
  jpegQuality: 0.1,            // 容量削減のため圧縮率を高める
  periodicIntervalMs: 30000,   // 30秒
  focusLostDelayMs: 5000,      // 5秒後から撮影開始
  focusLostIntervalMs: 5000,   // フォーカス喪失中は5秒ごとに撮影
};

// HMRによる複数インスタンス生成を防ぐためのグローバルタイマーID追跡
declare global {
  interface Window {
    __screencapture_timer_id?: number;
  }
}

export class ScreenCaptureService {
  private mediaStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private periodicTimer: number | null = null;
  private focusLostTimer: number | null = null;

  private options: Required<ScreenCaptureOptions>;
  private callback: ScreenCaptureCallback | null = null;
  private streamEndedCallback: StreamEndedCallback | null = null;
  private isCapturing = false;
  private permissionState: ScreenCapturePermissionState = 'prompt';

  constructor(options?: ScreenCaptureOptions) {
    // undefinedの値はデフォルトで上書きしないようにフィルタリング
    this.options = {
      jpegQuality: options?.jpegQuality ?? DEFAULT_OPTIONS.jpegQuality,
      periodicIntervalMs: options?.periodicIntervalMs ?? DEFAULT_OPTIONS.periodicIntervalMs,
      focusLostDelayMs: options?.focusLostDelayMs ?? DEFAULT_OPTIONS.focusLostDelayMs,
      focusLostIntervalMs: options?.focusLostIntervalMs ?? DEFAULT_OPTIONS.focusLostIntervalMs,
    };
    console.log('[ScreenCapture] Initialized with options:', this.options);
  }

  // ========================================
  // 静的メソッド
  // ========================================

  /**
   * Screen Capture APIの利用可否をチェック
   */
  static isSupported(): boolean {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  // ========================================
  // 権限管理
  // ========================================

  /**
   * 画面共有の許可を要求
   * ユーザーにディスプレイ選択ダイアログを表示
   * @param requireMonitor trueの場合、画面全体(monitor)のみを許可
   */
  async requestPermission(requireMonitor = true): Promise<{
    granted: boolean;
    error?: string;
    displaySurface?: string;
  }> {
    if (!ScreenCaptureService.isSupported()) {
      this.permissionState = 'unavailable';
      return { granted: false, error: 'Screen Capture API not supported' };
    }

    try {
      // getDisplayMediaを呼び出してユーザーにディスプレイ選択を促す
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor', // 画面全体を推奨
          cursor: 'always',          // カーソルも含める
        },
        audio: false,
      });

      // 選択されたdisplaySurfaceを確認
      const track = this.mediaStream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const displaySurface = settings?.displaySurface as string | undefined;

      console.log('[ScreenCapture] Selected displaySurface:', displaySurface);

      // 画面全体(monitor)が必須の場合、それ以外を拒否
      if (requireMonitor && displaySurface !== 'monitor') {
        console.warn('[ScreenCapture] Non-monitor surface selected:', displaySurface);
        // ストリームを停止
        this.cleanup();
        this.permissionState = 'prompt';
        return {
          granted: false,
          error: 'monitor_required',
          displaySurface,
        };
      }

      // 内部のビデオ要素とキャンバスをセットアップ
      await this.setupCaptureElements();

      // ストリーム終了（ユーザーが共有を停止）を監視
      track?.addEventListener('ended', () => {
        this.handleStreamEnded();
      });

      this.permissionState = 'granted';
      console.log('[ScreenCapture] Permission granted');
      return { granted: true, displaySurface };
    } catch (error) {
      const err = error as Error;
      console.error('[ScreenCapture] Permission request failed:', err.message);

      if (err.name === 'NotAllowedError') {
        this.permissionState = 'denied';
        return { granted: false, error: 'User denied screen capture permission' };
      }

      return { granted: false, error: err.message };
    }
  }

  /**
   * 現在の許可状態を取得
   */
  getPermissionState(): ScreenCapturePermissionState {
    return this.permissionState;
  }

  // ========================================
  // キャプチャ制御
  // ========================================

  /**
   * コールバックを設定
   */
  setCallback(callback: ScreenCaptureCallback): void {
    this.callback = callback;
  }

  /**
   * ストリーム停止時のコールバックを設定
   */
  setStreamEndedCallback(callback: StreamEndedCallback): void {
    this.streamEndedCallback = callback;
  }

  /**
   * 定期キャプチャを開始
   */
  startPeriodicCapture(): void {
    // 既存のタイマーをクリア（HMRによる多重登録防止）
    if (window.__screencapture_timer_id !== undefined) {
      console.log('[ScreenCapture] Clearing previous global timer:', window.__screencapture_timer_id);
      clearInterval(window.__screencapture_timer_id);
      window.__screencapture_timer_id = undefined;
    }

    if (this.periodicTimer !== null) {
      console.log('[ScreenCapture] Periodic capture already started on this instance, skipping');
      return; // 既に開始済み
    }

    const intervalMs = this.options.periodicIntervalMs;
    console.log(`[ScreenCapture] Starting periodic capture every ${intervalMs}ms (${intervalMs / 1000}s)`);

    // 最初のキャプチャを即座に実行
    this.captureNow('periodic').catch(console.error);

    // 定期的なキャプチャをスケジュール
    this.periodicTimer = window.setInterval(() => {
      console.log('[ScreenCapture] Periodic timer fired');
      this.captureNow('periodic').catch(console.error);
    }, intervalMs);

    // グローバル追跡用
    window.__screencapture_timer_id = this.periodicTimer;
  }

  /**
   * 定期キャプチャを停止
   */
  stopPeriodicCapture(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
      window.__screencapture_timer_id = undefined;
      console.log('[ScreenCapture] Periodic capture stopped');
    }
  }

  /**
   * フォーカス喪失イベントを処理
   * 5秒後から5秒ごとにフォーカス復帰までキャプチャを続ける
   */
  handleFocusLost(): void {
    // 既存のタイマーをキャンセル
    if (this.focusLostTimer !== null) {
      clearInterval(this.focusLostTimer);
    }

    console.log(
      `[ScreenCapture] Focus lost, starting capture in ${this.options.focusLostDelayMs}ms, ` +
        `then every ${this.options.focusLostIntervalMs}ms until focus regained`
    );

    // 最初のキャプチャを遅延後に実行し、その後は定期的にキャプチャ
    this.focusLostTimer = window.setTimeout(() => {
      // 最初のキャプチャを実行
      this.captureNow('focusLost').catch(console.error);

      // その後は定期的にキャプチャを続ける
      this.focusLostTimer = window.setInterval(() => {
        console.log('[ScreenCapture] Focus lost interval capture');
        this.captureNow('focusLost').catch(console.error);
      }, this.options.focusLostIntervalMs);
    }, this.options.focusLostDelayMs);
  }

  /**
   * フォーカス復帰時にスケジュール済みキャプチャをキャンセル
   */
  handleFocusRegained(): void {
    if (this.focusLostTimer !== null) {
      // setTimeout または setInterval どちらも clearInterval でクリア可能
      clearInterval(this.focusLostTimer);
      this.focusLostTimer = null;
      console.log('[ScreenCapture] Focus regained, stopped focus-lost captures');
    }
  }

  /**
   * 即座にスクリーンショットを撮影
   */
  async captureNow(captureType: ScreenshotCaptureType): Promise<CaptureResult> {
    if (this.isCapturing) {
      return { success: false, error: 'Capture already in progress' };
    }

    if (!this.mediaStream || this.permissionState !== 'granted') {
      return { success: false, error: 'Not initialized or permission not granted' };
    }

    this.isCapturing = true;

    try {
      const frameResult = await this.captureFrame();
      if (!frameResult) {
        return { success: false, error: 'Failed to capture frame' };
      }

      const { blob, displayInfo } = frameResult;
      const imageHash = await this.computeImageHash(blob);

      // コールバックを呼び出し
      if (this.callback) {
        this.callback(blob, imageHash, captureType, displayInfo);
      }

      console.log(`[ScreenCapture] Captured (${captureType}): ${imageHash.substring(0, 16)}...`);

      return {
        success: true,
        imageBlob: blob,
        imageHash,
        displayInfo,
      };
    } catch (error) {
      const err = error as Error;
      console.error('[ScreenCapture] Capture failed:', err.message);
      return { success: false, error: err.message };
    } finally {
      this.isCapturing = false;
    }
  }

  // ========================================
  // 内部メソッド
  // ========================================

  /**
   * キャプチャ用のDOM要素をセットアップ
   */
  private async setupCaptureElements(): Promise<void> {
    // ビデオ要素を作成
    this.videoElement = document.createElement('video');
    this.videoElement.srcObject = this.mediaStream;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;

    // メタデータが読み込まれるまで待機
    await new Promise<void>((resolve, reject) => {
      const video = this.videoElement!;
      video.onloadedmetadata = () => {
        video.play().then(() => resolve()).catch(reject);
      };
      video.onerror = () => reject(new Error('Video element error'));
    });

    // キャンバスを作成
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');

    console.log('[ScreenCapture] Capture elements setup complete');
  }

  /**
   * MediaStreamからフレームをキャプチャしてJPEGに変換
   */
  private async captureFrame(): Promise<{
    blob: Blob;
    displayInfo: DisplayInfo;
  } | null> {
    if (!this.mediaStream || !this.videoElement || !this.canvas || !this.ctx) {
      return null;
    }

    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) return null;

    const settings = track.getSettings();
    const width = settings.width ?? this.videoElement.videoWidth;
    const height = settings.height ?? this.videoElement.videoHeight;

    if (width === 0 || height === 0) {
      console.warn('[ScreenCapture] Invalid video dimensions');
      return null;
    }

    // キャンバスサイズを調整
    this.canvas.width = width;
    this.canvas.height = height;

    // 現在のフレームをキャンバスに描画
    this.ctx.drawImage(this.videoElement, 0, 0, width, height);

    // JPEGに変換
    const blob = await new Promise<Blob | null>((resolve) => {
      this.canvas!.toBlob(
        (b) => resolve(b),
        'image/jpeg',
        this.options.jpegQuality
      );
    });

    if (!blob) return null;

    const displayInfo: DisplayInfo = {
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
      displaySurface: settings.displaySurface as string | undefined,
    };

    return { blob, displayInfo };
  }

  /**
   * Blobのハッシュを計算
   */
  private async computeImageHash(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * ストリーム終了時のハンドラ
   */
  private handleStreamEnded(): void {
    console.log('[ScreenCapture] Stream ended by user');
    this.permissionState = 'denied';
    this.stopPeriodicCapture();
    this.cleanup();

    // コールバックを呼び出してUIに通知
    if (this.streamEndedCallback) {
      this.streamEndedCallback();
    }
  }

  /**
   * リソースをクリーンアップ
   */
  private cleanup(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    this.canvas = null;
    this.ctx = null;
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.stopPeriodicCapture();

    if (this.focusLostTimer !== null) {
      clearInterval(this.focusLostTimer);
      this.focusLostTimer = null;
    }

    this.cleanup();
    this.callback = null;
    this.permissionState = 'prompt';

    console.log('[ScreenCapture] Service disposed');
  }
}
