/**
 * Terminal progress display utilities
 */

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

export class Spinner {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    if (!process.stdout.isTTY) {
      console.log(this.message);
      return;
    }

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      process.stdout.write(`\r${frame} ${this.message}`);
      this.frameIndex++;
    }, 100);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (process.stdout.isTTY) {
      process.stdout.write('\r' + ' '.repeat(this.message.length + 5) + '\r');
    }

    if (finalMessage) {
      console.log(finalMessage);
    }
  }
}

export class ProgressBar {
  private total: number;
  private width: number;
  private label: string;
  private lastUpdate = 0;
  private updateInterval = 100; // ms

  constructor(total: number, label = 'Progress', width = 30) {
    this.total = total;
    this.width = width;
    this.label = label;
  }

  update(current: number, force = false): void {
    const now = Date.now();

    // Throttle updates to avoid terminal flickering
    if (!force && now - this.lastUpdate < this.updateInterval && current < this.total) {
      return;
    }
    this.lastUpdate = now;

    if (!process.stdout.isTTY) {
      return;
    }

    const percentage = Math.floor((current / this.total) * 100);
    const filled = Math.floor((current / this.total) * this.width);
    const empty = this.width - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

    process.stdout.write(
      `\r${this.label}: [${bar}] ${percentage}% (${current.toLocaleString()}/${this.total.toLocaleString()})`
    );
  }

  complete(): void {
    this.update(this.total, true);
    console.log();
  }
}
