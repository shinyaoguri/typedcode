/**
 * ChainPanel - ハッシュ鎖検証結果パネル
 *
 * ハッシュ鎖の検証結果とサンプリング検証の詳細を表示します。
 */

import type { SampledVerificationResult } from '@typedcode/shared';
import type { IPanel, PanelRenderContext } from './types.js';

/** ChainPanel の設定 */
export interface ChainPanelOptions {
  /** バッジ要素 */
  badgeEl: HTMLElement | null;
  /** メッセージ要素 */
  messageEl: HTMLElement | null;
  /** サンプリング検証コンテナ */
  sampledContainerEl: HTMLElement | null;
  /** サンプリングサマリー要素 */
  sampledSummaryEl: HTMLElement | null;
  /** サンプリング区間要素 */
  sampledSegmentsEl: HTMLElement | null;
}

/**
 * ハッシュ鎖検証結果パネル
 */
export class ChainPanel implements IPanel {
  private options: ChainPanelOptions;

  constructor(options: ChainPanelOptions) {
    this.options = options;
  }

  render(context: PanelRenderContext): void {
    const { verificationResult, proofData } = context;
    const { chainValid } = verificationResult;
    const hasCheckpoints = proofData.checkpoints && proofData.checkpoints.length > 0;
    const eventCount = proofData.proof?.events?.length ?? 0;

    // バッジを更新
    if (this.options.badgeEl) {
      if (chainValid) {
        this.options.badgeEl.innerHTML = '✅ 有効';
        this.options.badgeEl.className = 'badge success';
      } else {
        this.options.badgeEl.innerHTML = '❌ 無効';
        this.options.badgeEl.className = 'badge error';
      }
    }

    // メッセージを更新
    if (this.options.messageEl) {
      if (chainValid) {
        const modeInfo = hasCheckpoints
          ? `サンプリング検証で${proofData.checkpoints!.length}チェックポイントを使用`
          : '全イベントを検証';
        this.options.messageEl.textContent = `${modeInfo}して正常に検証されました（${eventCount}イベント）`;
      } else {
        this.options.messageEl.textContent = verificationResult.message ?? 'ハッシュ鎖の検証に失敗しました';
      }
    }

    // サンプリング検証結果を表示
    if (verificationResult.sampledResult) {
      this.renderSampledVerification(verificationResult.sampledResult);
    } else {
      this.hideSampledVerification();
    }
  }

  /**
   * サンプリング検証結果を表示
   */
  private renderSampledVerification(result: SampledVerificationResult): void {
    const { sampledContainerEl, sampledSummaryEl, sampledSegmentsEl } = this.options;

    if (!sampledContainerEl || !sampledSummaryEl || !sampledSegmentsEl) return;

    sampledContainerEl.style.display = 'block';

    // サマリー表示
    const percentage = ((result.totalEventsVerified / result.totalEvents) * 100).toFixed(1);
    sampledSummaryEl.innerHTML = `
      <div class="sampled-summary-text">
        <strong>サンプリング検証:</strong>
        ${result.sampledSegments.length} / ${result.totalSegments} 区間を検証
        (${result.totalEventsVerified} / ${result.totalEvents} イベント, ${percentage}%)
      </div>
    `;

    // 各区間の詳細を表示
    let segmentsHtml = '<div class="sampled-segments-list">';
    for (const segment of result.sampledSegments) {
      const statusIcon = segment.verified ? '✅' : '❌';
      const statusClass = segment.verified ? 'verified' : 'failed';
      segmentsHtml += `
        <div class="sampled-segment-item ${statusClass}">
          <span class="segment-status">${statusIcon}</span>
          <span class="segment-range">イベント ${segment.startIndex} - ${segment.endIndex}</span>
          <span class="segment-count">(${segment.eventCount} イベント)</span>
          <div class="segment-hashes">
            <span class="segment-hash" title="${segment.startHash}">開始: ${segment.startHash.substring(0, 12)}...</span>
            <span class="segment-hash" title="${segment.endHash}">終了: ${segment.endHash.substring(0, 12)}...</span>
          </div>
        </div>
      `;
    }
    segmentsHtml += '</div>';
    sampledSegmentsEl.innerHTML = segmentsHtml;
  }

  /**
   * サンプリング検証セクションを非表示
   */
  private hideSampledVerification(): void {
    if (this.options.sampledContainerEl) {
      this.options.sampledContainerEl.style.display = 'none';
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
    this.hideSampledVerification();
  }

  setVisible(visible: boolean): void {
    // このパネルは親要素で制御するため、個別の表示制御は不要
  }
}
