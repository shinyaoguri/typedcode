/**
 * StatusBarUI - Bottom status bar
 */
import { escapeHtml } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export class StatusBarUI {
  private queueStatus: HTMLElement;
  private fileCount: HTMLElement;

  /** 失敗サマリを押したときに呼ぶ (失敗した proof を開く)。サマリが失敗を含むときだけ押せる。 */
  private onFailedClick: (() => void) | null = null;
  private failedClickable = false;

  constructor() {
    this.queueStatus = document.getElementById('queue-status')!;
    this.fileCount = document.getElementById('file-count')!;
    this.queueStatus.addEventListener('click', () => {
      if (this.failedClickable) this.onFailedClick?.();
    });
  }

  setOnFailedClick(callback: () => void): void {
    this.onFailedClick = callback;
  }

  setQueueStatus(text: string, icon: string = 'check-circle'): void {
    // 集約 (setSummary) 以外の表示に切り替えたら、判定を表す属性・見た目・クリック導線を外す。
    // 前の集約が残ると E2E が古い件数を読む。
    this.clearSummaryState();
    // text には ZIP エントリ名やパースエラーメッセージ (攻撃者制御文字列) が入りうるため必ずエスケープする
    this.queueStatus.innerHTML = `<i class="fas fa-${icon}"></i><span>${escapeHtml(text)}</span>`;
  }

  setFileCount(count: number): void {
    const label = count !== 1 ? t('common.files') : t('common.file');
    this.fileCount.innerHTML = `<span>${count} ${label}</span>`;
  }

  /**
   * 検証が全件済んだあとの集約 (#282)。`passed` は警告を含む (CLI の `valid` と同じ軸)。
   * 数値は `data-proof-total/passed/failed` にも出す (E2E の状態契約。verify/AGENTS.md)。
   */
  setSummary(summary: { passed: number; total: number; failed: number }): void {
    const { passed, total, failed } = summary;
    this.clearSummaryState();
    const failedText =
      failed > 0 ? `<span class="status-summary-failed">${t('statusBar.summaryFailed', { failed })}</span>` : '';
    this.queueStatus.innerHTML = `
      <i class="fas fa-${failed > 0 ? 'exclamation-circle' : 'check-circle'}"></i>
      <span>${t('statusBar.summary', { passed, total })}</span>${failedText}
    `;
    this.queueStatus.dataset.proofTotal = String(total);
    this.queueStatus.dataset.proofPassed = String(passed);
    this.queueStatus.dataset.proofFailed = String(failed);
    if (failed > 0) {
      this.queueStatus.classList.add('clickable', 'has-failure');
      this.failedClickable = true;
    }
  }

  private clearSummaryState(): void {
    delete this.queueStatus.dataset.proofTotal;
    delete this.queueStatus.dataset.proofPassed;
    delete this.queueStatus.dataset.proofFailed;
    this.queueStatus.classList.remove('clickable', 'has-failure');
    this.failedClickable = false;
  }

  setVerifying(current: number, total: number): void {
    this.clearSummaryState();
    const percent = Math.round((current / total) * 100);
    this.queueStatus.innerHTML = `
      <i class="fas fa-spinner fa-spin"></i>
      <span>${t('statusBar.verifying', { current, total })}</span>
      <div class="status-queue-progress">
        <div class="status-queue-progress-bar" style="width: ${percent}%"></div>
      </div>
    `;
  }

  setReady(): void {
    this.setQueueStatus(t('statusBar.ready'), 'check-circle');
  }

  setError(message: string): void {
    this.setQueueStatus(message, 'exclamation-circle');
  }

  setMessage(message: string): void {
    this.setQueueStatus(message, 'info-circle');
  }
}
