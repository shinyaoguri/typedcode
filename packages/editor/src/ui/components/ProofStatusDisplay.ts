/**
 * ProofStatusDisplay - 証明ステータスのステータスバー表示
 * イベント数、ハッシュ、処理進捗をリアルタイム表示
 */

export interface ProofStats {
  totalEvents: number;
  currentHash: string | null;
  pendingCount: number;
}

export type GetStatsCallback = () => ProofStats | null;
export type SnapshotCallback = (content: string) => Promise<{ index: number }>;

const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * 8; // 円周 = 2πr (r=8)

export class ProofStatusDisplay {
  private eventCountEl: HTMLElement | null;
  private currentHashEl: HTMLElement | null;
  private proofStatusItemEl: HTMLElement | null;
  private proofProgressRing: HTMLElement | null;
  private progressBar: SVGCircleElement | null;
  private peakPendingCount = 0;
  private getStats: GetStatsCallback | null = null;
  private snapshotCallback: SnapshotCallback | null = null;
  private getEditorContent: (() => string) | null = null;
  private lastSnapshotEventCount = 0;

  constructor() {
    this.eventCountEl = document.getElementById('event-count');
    this.currentHashEl = document.getElementById('current-hash');
    this.proofStatusItemEl = document.getElementById('proof-status-item');
    this.proofProgressRing = document.getElementById('proof-progress-ring');
    this.progressBar = document.getElementById('progress-bar') as SVGCircleElement | null;
  }

  /**
   * 統計取得コールバックを設定
   */
  setGetStats(callback: GetStatsCallback): void {
    this.getStats = callback;
  }

  /**
   * スナップショットコールバックを設定
   */
  setSnapshotCallback(callback: SnapshotCallback, getEditorContent: () => string): void {
    this.snapshotCallback = callback;
    this.getEditorContent = getEditorContent;
  }

  /**
   * ステータス表示を更新
   */
  update(): void {
    const stats = this.getStats?.();
    if (!stats) return;

    // イベント数を更新
    if (this.eventCountEl) {
      this.eventCountEl.textContent = String(stats.totalEvents);
    }

    // 現在のハッシュを更新
    if (this.currentHashEl && stats.currentHash) {
      this.currentHashEl.textContent = stats.currentHash.substring(0, 16) + '...';
      this.currentHashEl.title = stats.currentHash;
    }

    // プログレスリングを更新
    this.updateProgressRing(stats);

    // 100イベントごとにスナップショット記録
    this.checkSnapshot(stats);
  }

  /**
   * プログレスリングを更新
   */
  private updateProgressRing(stats: ProofStats): void {
    if (!this.proofProgressRing || !this.progressBar) return;

    if (stats.pendingCount > 0) {
      // 処理中: プログレスリングを表示
      this.proofProgressRing.classList.add('processing');

      // ピーク値を更新（キューが増えた場合）
      if (stats.pendingCount > this.peakPendingCount) {
        this.peakPendingCount = stats.pendingCount;
      }

      // 進捗を計算（処理済み / ピーク値）
      const processed = this.peakPendingCount - stats.pendingCount;
      const progress = this.peakPendingCount > 0 ? processed / this.peakPendingCount : 0;

      // stroke-dashoffsetを設定（0 = 100%, circumference = 0%）
      const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - progress);
      this.progressBar.style.strokeDashoffset = String(offset);

      // ツールチップを更新
      this.proofStatusItemEl?.setAttribute(
        'title',
        `Processing: ${stats.pendingCount} remaining (${processed}/${this.peakPendingCount} done)`
      );
    } else {
      // 待機中: プログレスリングを非表示、ピークをリセット
      this.proofProgressRing.classList.remove('processing');
      this.peakPendingCount = 0;
      this.progressBar.style.strokeDashoffset = String(PROGRESS_RING_CIRCUMFERENCE);
      this.proofStatusItemEl?.setAttribute('title', 'Typing proof status');
    }
  }

  /**
   * 100イベントごとにスナップショットをチェック
   */
  private checkSnapshot(stats: ProofStats): void {
    if (!this.snapshotCallback || !this.getEditorContent) return;

    // 100イベントごとにスナップショット記録
    const snapshotThreshold = Math.floor(stats.totalEvents / 100) * 100;
    if (
      stats.totalEvents > 0 &&
      stats.totalEvents % 100 === 0 &&
      snapshotThreshold > this.lastSnapshotEventCount
    ) {
      this.lastSnapshotEventCount = snapshotThreshold;
      const editorContent = this.getEditorContent();

      this.snapshotCallback(editorContent)
        .then((result) => {
          console.log('[TypedCode] Content snapshot recorded at event', result.index);
        })
        .catch((error) => {
          console.error('[TypedCode] Snapshot recording failed:', error);
        });
    }
  }

  /**
   * 表示をリセット
   */
  reset(): void {
    this.peakPendingCount = 0;
    this.lastSnapshotEventCount = 0;

    if (this.eventCountEl) {
      this.eventCountEl.textContent = '0';
    }
    if (this.currentHashEl) {
      this.currentHashEl.textContent = '-';
      this.currentHashEl.title = '';
    }
    if (this.progressBar) {
      this.progressBar.style.strokeDashoffset = String(PROGRESS_RING_CIRCUMFERENCE);
    }
    this.proofProgressRing?.classList.remove('processing');
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.eventCountEl = null;
    this.currentHashEl = null;
    this.proofStatusItemEl = null;
    this.proofProgressRing = null;
    this.progressBar = null;
    this.getStats = null;
    this.snapshotCallback = null;
    this.getEditorContent = null;
  }
}
