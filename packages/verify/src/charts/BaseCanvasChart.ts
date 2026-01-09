/**
 * BaseCanvasChart - キャンバスチャートの基底クラス
 *
 * TimelineChart と MouseChart の共通パターンを抽出した抽象基底クラス。
 * キャンバス初期化、表示/非表示、キャッシュ管理などの共通機能を提供します。
 */

import type { StoredEvent } from '@typedcode/shared';
import { ChartUtils, type CanvasContext } from './ChartUtils.js';

// ============================================================================
// 型定義
// ============================================================================

/** 基本チャートオプション */
export interface BaseChartOptions {
  /** メインキャンバス要素 */
  canvas: HTMLCanvasElement | null;
  /** セクション/コンテナ要素（表示/非表示用） */
  container?: HTMLElement | null;
}

// ============================================================================
// BaseCanvasChart 抽象クラス
// ============================================================================

/**
 * キャンバスチャートの抽象基底クラス
 *
 * @template TCache - チャート固有のキャッシュ型
 * @template TOptions - チャート固有のオプション型
 */
export abstract class BaseCanvasChart<TCache, TOptions extends BaseChartOptions = BaseChartOptions> {
  protected options: TOptions;
  protected cache: TCache | null = null;
  protected canvasContext: CanvasContext | null = null;

  constructor(options: TOptions) {
    this.options = options;
  }

  // --------------------------------------------------------------------------
  // キャッシュ管理
  // --------------------------------------------------------------------------

  /**
   * キャッシュを取得
   */
  getCache(): TCache | null {
    return this.cache;
  }

  /**
   * キャッシュを設定
   */
  setCache(cache: TCache): void {
    this.cache = cache;
  }

  // --------------------------------------------------------------------------
  // 表示/非表示
  // --------------------------------------------------------------------------

  /**
   * チャートを表示
   */
  show(): void {
    const container = this.getDisplayContainer();
    if (container) {
      container.style.display = 'block';
    }
  }

  /**
   * チャートを非表示
   */
  hide(): void {
    const container = this.getDisplayContainer();
    if (container) {
      container.style.display = 'none';
    }
  }

  /**
   * 表示/非表示対象のコンテナ要素を取得
   * サブクラスでオーバーライド可能
   */
  protected getDisplayContainer(): HTMLElement | null {
    return this.options.container ?? this.options.canvas?.parentElement ?? null;
  }

  // --------------------------------------------------------------------------
  // キャンバス操作
  // --------------------------------------------------------------------------

  /**
   * キャンバスを初期化
   * @returns キャンバスコンテキスト情報、または初期化失敗時は null
   */
  protected initCanvas(): CanvasContext | null {
    if (!this.options.canvas) return null;

    const canvasInit = ChartUtils.initCanvas(this.options.canvas);
    if (!canvasInit) return null;

    this.canvasContext = canvasInit;
    return canvasInit;
  }

  /**
   * 背景を描画
   * サブクラスでオーバーライドして背景色をカスタマイズ可能
   */
  protected drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = this.getBackgroundColor();
    ctx.fillRect(0, 0, width, height);
  }

  /**
   * 背景色を取得
   * サブクラスでオーバーライド可能
   */
  protected getBackgroundColor(): string {
    return '#ffffff';
  }

  // --------------------------------------------------------------------------
  // 抽象メソッド
  // --------------------------------------------------------------------------

  /**
   * チャートを描画
   * @param events - 全イベント
   * @param currentEvents - 現在表示中のイベント
   */
  abstract draw(events: StoredEvent[], currentEvents: StoredEvent[]): void;

  /**
   * マーカーを更新
   * @param eventIndex - 現在のイベントインデックス
   * @param events - 全イベント
   */
  abstract updateMarker(eventIndex: number, events: StoredEvent[]): void;
}
