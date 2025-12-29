/**
 * VerifyStatusBar - 検証ページのステータスバー
 * 処理待ち件数と現在の検証進捗を表示
 */

import type { ProgressDetails } from '../types.js';

export interface StatusBarState {
  pendingCount: number;
  currentFile: string | null;
  currentProgress: number;
  progressDetails?: ProgressDetails;
}

export class VerifyStatusBar {
  private container: HTMLElement;
  private queueStatusEl: HTMLElement | null = null;
  private currentStatusEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.initialize();
  }

  /**
   * DOM要素を初期化
   */
  private initialize(): void {
    this.queueStatusEl = this.container.querySelector('#queue-status');
    this.currentStatusEl = this.container.querySelector('#current-status');
  }

  /**
   * フェーズの日本語表示を取得
   */
  private getPhaseLabel(phase: string): string {
    switch (phase) {
      case 'metadata': return 'メタデータ検証';
      case 'chain': return 'ハッシュ鎖検証';
      case 'checkpoint': return 'チェックポイント確認';
      case 'segment': return 'サンプリング検証';
      case 'full': return 'ハッシュ鎖検証';
      case 'fallback': return 'フォールバック検証';
      case 'complete': return '完了処理';
      default: return phase;
    }
  }

  /**
   * イベント数を表示するフェーズかどうか
   */
  private isEventCountPhase(phase: string): boolean {
    return phase === 'chain' || phase === 'segment' || phase === 'full';
  }

  /**
   * ステータスを更新
   * 表示形式: 「処理待ち: N件 / 検証中: filename - ハッシュ鎖検証 (123/456 イベント)」
   */
  update(state: StatusBarState): void {
    if (this.queueStatusEl) {
      this.queueStatusEl.textContent = `処理待ち: ${state.pendingCount}件`;
    }

    if (this.currentStatusEl) {
      if (state.currentFile) {
        // ファイル名からパスを除去
        const displayName = state.currentFile.split('/').pop() ?? state.currentFile;
        // 長すぎる場合は省略
        const truncated = displayName.length > 20
          ? displayName.substring(0, 17) + '...'
          : displayName;

        // 詳細進捗があれば表示
        if (state.progressDetails) {
          const details = state.progressDetails;
          const phaseLabel = this.getPhaseLabel(details.phase);

          if (this.isEventCountPhase(details.phase)) {
            // ハッシュ鎖/サンプリング検証中は詳細を表示
            this.currentStatusEl.textContent = `${truncated} - ${phaseLabel} (${details.current.toLocaleString()}/${details.total.toLocaleString()} イベント)`;
          } else {
            // その他のフェーズは簡易表示
            this.currentStatusEl.textContent = `${truncated} - ${phaseLabel}`;
          }
        } else {
          // 詳細情報がない場合は従来表示
          this.currentStatusEl.textContent = `検証中: ${truncated} (${state.currentProgress}%)`;
        }
      } else if (state.pendingCount === 0) {
        this.currentStatusEl.textContent = '検証完了';
      } else {
        this.currentStatusEl.textContent = '-';
      }
    }
  }

  /**
   * 完了状態を表示
   */
  showComplete(totalFiles: number, successCount: number, errorCount: number): void {
    if (this.queueStatusEl) {
      this.queueStatusEl.textContent = `完了: ${totalFiles}件`;
    }

    if (this.currentStatusEl) {
      if (errorCount > 0) {
        this.currentStatusEl.textContent = `成功: ${successCount}件 / エラー: ${errorCount}件`;
      } else {
        this.currentStatusEl.textContent = `全件検証成功`;
      }
    }
  }

  /**
   * ステータスバーを表示
   */
  show(): void {
    this.container.style.display = 'flex';
  }

  /**
   * ステータスバーを非表示
   */
  hide(): void {
    this.container.style.display = 'none';
  }

  /**
   * リセット
   */
  reset(): void {
    this.update({
      pendingCount: 0,
      currentFile: null,
      currentProgress: 0,
    });
  }
}
