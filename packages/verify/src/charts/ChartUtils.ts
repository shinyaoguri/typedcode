/**
 * ChartUtils - チャート共通ユーティリティ
 *
 * キャンバス初期化や共通の描画関数を提供します。
 */

// ============================================================================
// 型定義
// ============================================================================

/** キャンバス初期化結果 */
export interface CanvasContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
}

// ============================================================================
// ChartUtils クラス
// ============================================================================

/**
 * チャートユーティリティ
 */
export class ChartUtils {
  /**
   * キャンバスを初期化（デバイスピクセル比を考慮）
   */
  static initCanvas(canvas: HTMLCanvasElement): CanvasContext | null {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const dpr = window.devicePixelRatio ?? 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    return { ctx, width: rect.width, height: rect.height, dpr };
  }

  /**
   * 時間をフォーマット（mm:ss.ms）
   */
  static formatTime(ms: number): string {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((ms % 1000) / 10);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}`;
  }

  /**
   * 時間を短いフォーマットに（秒.ms）
   */
  static formatTimeShort(ms: number): string {
    return `${(ms / 1000).toFixed(2)}秒`;
  }

  /**
   * 色を生成（HSL）
   */
  static hslColor(h: number, s: number = 70, l: number = 50, a: number = 1): string {
    return `hsla(${h}, ${s}%, ${l}%, ${a})`;
  }

  /**
   * 線形補間
   */
  static lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  /**
   * 値を範囲内にクランプ
   */
  static clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 座標を時間に変換
   */
  static xToTime(x: number, chartWidth: number, totalTime: number, paddingLeft: number): number {
    return ((x - paddingLeft) / chartWidth) * totalTime;
  }

  /**
   * 時間を座標に変換
   */
  static timeToX(time: number, chartWidth: number, totalTime: number, paddingLeft: number): number {
    return paddingLeft + (time / totalTime) * chartWidth;
  }
}
