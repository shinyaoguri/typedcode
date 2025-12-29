/**
 * PoswPanel - PoSW (Proof of Sequential Work) 統計パネル
 *
 * PoSWの検証結果と統計情報を表示します。
 */

import type { IPanel, PanelRenderContext } from './types.js';

/** PoswPanel の設定 */
export interface PoswPanelOptions {
  /** バッジ要素 */
  badgeEl: HTMLElement | null;
  /** メッセージ要素 */
  messageEl: HTMLElement | null;
  /** イテレーション数要素 */
  iterationsEl: HTMLElement | null;
  /** 平均時間要素 */
  avgTimeEl: HTMLElement | null;
  /** 合計時間要素 */
  totalTimeEl: HTMLElement | null;
}

/**
 * PoSW統計パネル
 */
export class PoswPanel implements IPanel {
  private options: PoswPanelOptions;

  constructor(options: PoswPanelOptions) {
    this.options = options;
  }

  render(context: PanelRenderContext): void {
    const { verificationResult } = context;
    const { chainValid, poswStats } = verificationResult;

    if (!poswStats || poswStats.count === 0) {
      // PoSWなし（古いバージョンの証明ファイル）
      this.renderNoPoSW();
      return;
    }

    // バッジを更新
    if (this.options.badgeEl) {
      if (chainValid) {
        this.options.badgeEl.innerHTML = '✅ 検証済み';
        this.options.badgeEl.className = 'badge success';
      } else {
        this.options.badgeEl.innerHTML = '❌ 検証失敗';
        this.options.badgeEl.className = 'badge error';
      }
    }

    // メッセージを更新
    if (this.options.messageEl) {
      if (chainValid) {
        this.options.messageEl.textContent = `全${poswStats.count}イベントのPoSWが検証されました`;
      } else {
        this.options.messageEl.textContent = 'ハッシュ鎖検証に失敗したためPoSWも無効';
      }
    }

    // 統計を表示
    if (this.options.iterationsEl) {
      this.options.iterationsEl.textContent = `${poswStats.iterations.toLocaleString()}回/イベント`;
    }
    if (this.options.avgTimeEl) {
      this.options.avgTimeEl.textContent = `${poswStats.avgTimeMs.toFixed(1)}ms`;
    }
    if (this.options.totalTimeEl) {
      this.options.totalTimeEl.textContent = `${(poswStats.totalTimeMs / 1000).toFixed(2)}秒`;
    }
  }

  /**
   * PoSWなしの場合の表示
   */
  private renderNoPoSW(): void {
    if (this.options.badgeEl) {
      this.options.badgeEl.innerHTML = '⚠️ なし';
      this.options.badgeEl.className = 'badge warning';
    }
    if (this.options.messageEl) {
      this.options.messageEl.textContent = 'この証明ファイルにはPoSWが含まれていません（v2.x以前）';
    }
    if (this.options.iterationsEl) {
      this.options.iterationsEl.textContent = '-';
    }
    if (this.options.avgTimeEl) {
      this.options.avgTimeEl.textContent = '-';
    }
    if (this.options.totalTimeEl) {
      this.options.totalTimeEl.textContent = '-';
    }
  }

  clear(): void {
    if (this.options.badgeEl) {
      this.options.badgeEl.innerHTML = '';
      this.options.badgeEl.className = 'badge';
    }
    if (this.options.messageEl) {
      this.options.messageEl.textContent = '';
    }
    if (this.options.iterationsEl) {
      this.options.iterationsEl.textContent = '';
    }
    if (this.options.avgTimeEl) {
      this.options.avgTimeEl.textContent = '';
    }
    if (this.options.totalTimeEl) {
      this.options.totalTimeEl.textContent = '';
    }
  }

  setVisible(visible: boolean): void {
    // このパネルは親要素で制御するため、個別の表示制御は不要
  }
}
