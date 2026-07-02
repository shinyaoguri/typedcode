/**
 * StatusBarUI - Bottom status bar
 */
import { escapeHtml } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export class StatusBarUI {
  private queueStatus: HTMLElement;
  private fileCount: HTMLElement;

  constructor() {
    this.queueStatus = document.getElementById('queue-status')!;
    this.fileCount = document.getElementById('file-count')!;
  }

  setQueueStatus(text: string, icon: string = 'check-circle'): void {
    // text には ZIP エントリ名やパースエラーメッセージ (攻撃者制御文字列) が入りうるため必ずエスケープする
    this.queueStatus.innerHTML = `<i class="fas fa-${icon}"></i><span>${escapeHtml(text)}</span>`;
  }

  setFileCount(count: number): void {
    const label = count !== 1 ? t('common.files') : t('common.file');
    this.fileCount.innerHTML = `<span>${count} ${label}</span>`;
  }

  setVerifying(current: number, total: number): void {
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
