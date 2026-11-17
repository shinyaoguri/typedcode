/**
 * ProcessingDialog - ハッシュチェーン処理待機ダイアログ
 * エクスポート前に未処理のイベントが完了するまで表示
 *
 * `index.html` の静的 overlay (`#processing-dialog`)。a11y (#305) は `dialogA11y` の `showStaticDialog`:
 * 名前付きの modal dialog にしてキャンセルへフォーカスし、Tab を閉じ込める。Escape では閉じない
 * (従来どおり。中止はキャンセルボタン)。完了・キャンセル・`forceClose` のどれでも `cleanup` を通り、
 * interval とリスナーはそこで解放され、待ちの Promise もそこで settle する (完了なら true、それ以外は false)。
 * 前の待ちが残ったまま `waitForComplete` を呼ぶと、前の待ちは false で終わる (#744)。
 */

import { t } from '../../i18n/index.js';
import { showStaticDialog, type DialogA11yHandle } from './dialogA11y.js';

export interface ProcessingStats {
  pendingCount: number;
  processedCount?: number;
}

export type GetStatsCallback = () => ProcessingStats;

export class ProcessingDialog {
  private dialog: HTMLElement | null;
  private progressBar: HTMLElement | null;
  private statusText: HTMLElement | null;
  private cancelBtn: HTMLElement | null;
  private cancelled = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  /** 待っている `waitForComplete` の resolve。閉じる・置き換えるときに必ず settle する (#744) */
  private resolvePending: ((completed: boolean) => void) | null = null;
  private a11y: DialogA11yHandle | null = null;

  constructor() {
    this.dialog = document.getElementById('processing-dialog');
    this.progressBar = document.getElementById('processing-progress-bar');
    this.statusText = document.getElementById('processing-status');
    this.cancelBtn = document.getElementById('processing-cancel-btn');

    this.cancelBtn?.addEventListener('click', () => {
      this.cancelled = true;
    });
  }

  /**
   * 処理が完了するまで待機
   * @param getStats 現在の処理状態を取得するコールバック
   * @returns true: 完了, false: キャンセルされた
   */
  async waitForComplete(getStats: GetStatsCallback): Promise<boolean> {
    const initialStats = getStats();

    if (initialStats.pendingCount === 0) {
      return true; // 待機不要
    }

    // 前の待ちが残っていれば interval を止め、その Promise は中止 (false) で settle する (#744)
    this.stopWaiting(false);

    // ダイアログを表示
    this.cancelled = false;
    if (this.dialog) {
      this.a11y?.close();
      this.a11y = showStaticDialog(this.dialog, { closeOnEscape: false });
    }

    const initialPending = initialStats.pendingCount;

    return new Promise<boolean>((resolve) => {
      this.resolvePending = resolve;
      this.checkInterval = setInterval(() => {
        const currentStats = getStats();

        if (this.cancelled) {
          this.cleanup();
          return;
        }

        if (currentStats.pendingCount === 0) {
          this.cleanup(true);
          return;
        }

        // プログレスバーを更新
        const processed = initialPending - currentStats.pendingCount;
        const progress = initialPending > 0 ? (processed / initialPending) * 100 : 0;

        if (this.progressBar) {
          this.progressBar.style.width = `${progress}%`;
        }

        if (this.statusText) {
          this.statusText.textContent = t('processingDialog.statusWithProgress', {
            count: currentStats.pendingCount,
            processed,
            total: initialPending,
          });
        }
      }, 100);
    });
  }

  /**
   * ダイアログを強制的に閉じる
   */
  forceClose(): void {
    this.cancelled = true;
    this.cleanup();
  }

  /**
   * 待ちを終える: interval を止め、待っている Promise を settle する
   */
  private stopWaiting(completed: boolean): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    const resolve = this.resolvePending;
    this.resolvePending = null;
    resolve?.(completed);
  }

  /**
   * クリーンアップ (待ちが残っていれば completed で settle する。既定は中止 = false)
   */
  private cleanup(completed = false): void {
    this.stopWaiting(completed);
    this.a11y?.close();
    this.a11y = null;
    this.dialog?.classList.add('hidden');
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.cleanup();
    this.dialog = null;
    this.progressBar = null;
    this.statusText = null;
    this.cancelBtn = null;
  }
}
