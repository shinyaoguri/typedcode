/**
 * TitlebarClock - タイトルバーに現在時刻を表示
 * ハッシュチェーンに記録されるタイムスタンプを人間が分かりやすく表示
 * Format: YYYY-MM-DD / HH:MM:SS
 */

export class TitlebarClock {
  private clockEl: HTMLElement | null;
  private intervalId: number | null = null;

  constructor() {
    this.clockEl = document.getElementById('clock-display');
  }

  /**
   * 時計を開始
   */
  start(): void {
    if (this.intervalId !== null) return;

    // 初回表示
    this.updateClock();

    // 1秒ごとに更新
    this.intervalId = window.setInterval(() => {
      this.updateClock();
    }, 1000);
  }

  /**
   * 時計を停止
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 時刻表示を更新
   */
  private updateClock(): void {
    if (!this.clockEl) return;

    const now = new Date();
    const formatted = this.formatDateTime(now);
    this.clockEl.textContent = formatted;
  }

  /**
   * 日時をフォーマット: YYYY-MM-DD / HH:MM:SS
   */
  private formatDateTime(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} / ${hours}:${minutes}:${seconds}`;
  }

  /**
   * クリーンアップ
   */
  dispose(): void {
    this.stop();
    this.clockEl = null;
  }
}
