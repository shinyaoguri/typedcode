/**
 * StatusBarUI - Bottom status bar
 */
import { t } from '../i18n/index.js';

export class StatusBarUI {
  private statusbar: HTMLElement;
  private queueStatus: HTMLElement;
  private fileCount: HTMLElement;

  constructor() {
    this.statusbar = document.getElementById('statusbar')!;
    this.queueStatus = document.getElementById('queue-status')!;
    this.fileCount = document.getElementById('file-count')!;
  }

  setQueueStatus(text: string, icon: string = 'check-circle'): void {
    this.queueStatus.innerHTML = `<i class="fas fa-${icon}"></i><span>${text}</span>`;
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
