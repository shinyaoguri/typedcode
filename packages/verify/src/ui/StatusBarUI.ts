/**
 * StatusBarUI - Bottom status bar
 */
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
    this.fileCount.innerHTML = `<span>${count} file${count !== 1 ? 's' : ''}</span>`;
  }

  setVerifying(current: number, total: number): void {
    const percent = Math.round((current / total) * 100);
    this.queueStatus.innerHTML = `
      <i class="fas fa-spinner fa-spin"></i>
      <span>検証中 ${current}/${total}</span>
      <div class="status-queue-progress">
        <div class="status-queue-progress-bar" style="width: ${percent}%"></div>
      </div>
    `;
  }

  setReady(): void {
    this.setQueueStatus('Ready', 'check-circle');
  }

  setError(message: string): void {
    this.setQueueStatus(message, 'exclamation-circle');
  }

  setMessage(message: string): void {
    this.setQueueStatus(message, 'info-circle');
  }
}
