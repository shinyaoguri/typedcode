/**
 * MouseChart - マウス軌跡チャート
 *
 * マウスの移動軌跡とウィンドウ枠を表示するチャートコンポーネント。
 *
 * charts.ts から抽出。BaseCanvasChart を継承。
 */

import type { StoredEvent, MousePositionData, WindowSizeData } from '@typedcode/shared';
import type { MouseTrajectoryCache } from '../types.js';
import { BaseCanvasChart, type BaseChartOptions } from './BaseCanvasChart.js';

// ============================================================================
// 型定義
// ============================================================================

/** MouseChart の設定 */
export interface MouseChartOptions extends BaseChartOptions {
  /** セクション要素 */
  section?: HTMLElement | null;
  /** モーダル用キャンバス要素 */
  modalCanvas?: HTMLCanvasElement | null;
  /** モーダル用セクション要素 */
  modalSection?: HTMLElement | null;
}

// ============================================================================
// MouseChart クラス
// ============================================================================

/**
 * マウス軌跡チャート
 */
export class MouseChart extends BaseCanvasChart<MouseTrajectoryCache, MouseChartOptions> {
  /**
   * 背景色を取得（薄いグレー）
   */
  protected override getBackgroundColor(): string {
    return '#f8f9fa';
  }

  /**
   * 表示/非表示対象のコンテナ要素を取得
   * MouseChart は section 要素を使用
   */
  protected override getDisplayContainer(): HTMLElement | null {
    return this.options.section ?? null;
  }

  /**
   * チャートを描画
   */
  draw(events: StoredEvent[], currentEvents: StoredEvent[]): void {
    if (!this.options.canvas) return;

    const mouseEvents = events.filter(e => e.type === 'mousePositionChange');
    if (mouseEvents.length === 0) {
      this.hide();
      return;
    }

    this.show();

    const canvasInit = this.initCanvas();
    if (!canvasInit) return;

    const { ctx, width, height } = canvasInit;

    // マウスイベントからデータを抽出
    const positions: { x: number; y: number; time: number; eventIndex: number }[] = [];
    const windowRects: { x: number; y: number; width: number; height: number; time: number }[] = [];

    let minScreenX = Infinity;
    let minScreenY = Infinity;
    let maxX = 0;
    let maxY = 0;

    mouseEvents.forEach(event => {
      const data = event.data as MousePositionData | null;
      if (data && typeof data === 'object' && 'x' in data && 'y' in data) {
        const eventIndex = currentEvents.findIndex(e => e.sequence === event.sequence);
        positions.push({
          x: data.x,
          y: data.y,
          time: event.timestamp,
          eventIndex
        });
        maxX = Math.max(maxX, data.x);
        maxY = Math.max(maxY, data.y);

        // スクリーン座標の最小値
        if ('screenX' in data && 'screenY' in data) {
          minScreenX = Math.min(minScreenX, data.screenX);
          minScreenY = Math.min(minScreenY, data.screenY);
        }
      }
    });

    // ウィンドウリサイズイベントを抽出
    const resizeEvents = events.filter(e => e.type === 'windowResize');
    resizeEvents.forEach(event => {
      const data = event.data as WindowSizeData | null;
      if (data && typeof data === 'object' && 'width' in data && 'height' in data) {
        windowRects.push({
          x: data.screenX ?? 0,
          y: data.screenY ?? 0,
          width: data.width,
          height: data.height,
          time: event.timestamp
        });
      }
    });

    if (positions.length === 0) {
      this.hide();
      return;
    }

    // スケールとパディング
    const padding = { top: 20, right: 20, bottom: 20, left: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const scaleX = chartWidth / (maxX || 1);
    const scaleY = chartHeight / (maxY || 1);
    const scale = Math.min(scaleX, scaleY);

    // キャッシュを保存
    this.cache = {
      positions,
      scale,
      padding,
      maxX,
      maxY,
      minScreenX: Number.isFinite(minScreenX) ? minScreenX : 0,
      minScreenY: Number.isFinite(minScreenY) ? minScreenY : 0,
      windowRects,
    };

    // 描画
    super.drawBackground(ctx, width, height);
    this.drawWindowRects(ctx, windowRects, padding, scale, minScreenX, minScreenY);
    this.drawTrajectory(ctx, positions, padding, scale);
  }

  /**
   * マーカーを更新
   */
  updateMarker(eventIndex: number, _events: StoredEvent[]): void {
    if (!this.cache || !this.options.canvas) return;

    // キャンバスを再初期化
    const canvasInit = this.initCanvas();
    if (!canvasInit) return;

    const { ctx, width, height } = canvasInit;
    const { positions, scale, padding, windowRects, minScreenX, minScreenY } = this.cache;

    // 背景とウィンドウ枠を再描画
    super.drawBackground(ctx, width, height);
    this.drawWindowRects(ctx, windowRects, padding, scale, minScreenX, minScreenY);

    // 軌跡を描画（現在位置までハイライト）
    this.drawTrajectoryWithMarker(ctx, positions, padding, scale, eventIndex);
  }

  /**
   * 現在位置のインデックスで再描画
   */
  redraw(eventIndex: number): void {
    if (!this.cache || !this.options.canvas) return;

    const canvasInit = this.initCanvas();
    if (!canvasInit) return;

    const { ctx, width, height } = canvasInit;
    const { positions, scale, padding, windowRects, minScreenX, minScreenY } = this.cache;

    super.drawBackground(ctx, width, height);
    this.drawWindowRects(ctx, windowRects, padding, scale, minScreenX, minScreenY);
    this.drawTrajectoryWithMarker(ctx, positions, padding, scale, eventIndex);
  }

  /**
   * ウィンドウ枠を描画
   */
  private drawWindowRects(
    ctx: CanvasRenderingContext2D,
    windowRects: { x: number; y: number; width: number; height: number; time: number }[],
    padding: { left: number; top: number },
    scale: number,
    minScreenX: number,
    minScreenY: number
  ): void {
    windowRects.forEach((rect, index) => {
      const alpha = 0.1 + (index / windowRects.length) * 0.2;
      ctx.strokeStyle = `rgba(100, 100, 100, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        padding.left + (rect.x - minScreenX) * scale,
        padding.top + (rect.y - minScreenY) * scale,
        rect.width * scale,
        rect.height * scale
      );
    });
    ctx.setLineDash([]);
  }

  /**
   * 軌跡を描画
   */
  private drawTrajectory(
    ctx: CanvasRenderingContext2D,
    positions: { x: number; y: number; time: number; eventIndex: number }[],
    padding: { left: number; top: number },
    scale: number
  ): void {
    if (positions.length === 0) return;

    // グラデーション軌跡
    ctx.lineWidth = 2;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const curr = positions[i]!;
      const progress = i / positions.length;

      ctx.strokeStyle = `hsla(${260 - progress * 60}, 70%, 50%, ${0.3 + progress * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
      ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
      ctx.stroke();
    }

    // 終点マーカー
    const lastPos = positions[positions.length - 1]!;
    ctx.fillStyle = '#667eea';
    ctx.beginPath();
    ctx.arc(
      padding.left + lastPos.x * scale,
      padding.top + lastPos.y * scale,
      6, 0, Math.PI * 2
    );
    ctx.fill();
  }

  /**
   * マーカー付き軌跡を描画
   */
  private drawTrajectoryWithMarker(
    ctx: CanvasRenderingContext2D,
    positions: { x: number; y: number; time: number; eventIndex: number }[],
    padding: { left: number; top: number },
    scale: number,
    eventIndex: number
  ): void {
    if (positions.length === 0) return;

    // 現在位置までの軌跡を探す
    let currentPosIndex = positions.length - 1;
    for (let i = 0; i < positions.length; i++) {
      if (positions[i]!.eventIndex >= eventIndex) {
        currentPosIndex = i;
        break;
      }
    }

    // 軌跡を描画
    ctx.lineWidth = 2;
    for (let i = 1; i <= currentPosIndex && i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const curr = positions[i]!;
      const progress = i / positions.length;

      ctx.strokeStyle = `hsla(${260 - progress * 60}, 70%, 50%, ${0.3 + progress * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
      ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
      ctx.stroke();
    }

    // 残りの軌跡（薄く）
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    for (let i = currentPosIndex + 1; i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const curr = positions[i]!;
      ctx.beginPath();
      ctx.moveTo(padding.left + prev.x * scale, padding.top + prev.y * scale);
      ctx.lineTo(padding.left + curr.x * scale, padding.top + curr.y * scale);
      ctx.stroke();
    }

    // 現在位置マーカー
    if (currentPosIndex < positions.length) {
      const pos = positions[currentPosIndex]!;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(
        padding.left + pos.x * scale,
        padding.top + pos.y * scale,
        8, 0, Math.PI * 2
      );
      ctx.fill();

      // 白い縁取り
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
