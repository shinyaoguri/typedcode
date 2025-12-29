/**
 * EventRecorder - 中央イベント記録システム
 * 各種トラッカーからのイベントを受け取り、TypingProofに記録
 */

import type { RecordEventInput } from '@typedcode/shared';
import type { TabManager } from '../ui/tabs/TabManager.js';
import type { LogViewer } from '../ui/components/LogViewer.js';
import { t } from '../i18n/index.js';

export interface EventRecorderOptions {
  tabManager: TabManager;
  logViewer: LogViewer | null;
  onStatusUpdate?: () => void;
  onError?: (message: string) => void;
}

export class EventRecorder {
  private tabManager: TabManager;
  private logViewer: LogViewer | null;
  private onStatusUpdate: (() => void) | null;
  private onError: ((message: string) => void) | null;
  private enabled = true;
  private initialized = false;

  constructor(options: EventRecorderOptions) {
    this.tabManager = options.tabManager;
    this.logViewer = options.logViewer;
    this.onStatusUpdate = options.onStatusUpdate ?? null;
    this.onError = options.onError ?? null;
  }

  /**
   * イベント記録を有効化/無効化
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * 初期化済みフラグを設定
   */
  setInitialized(initialized: boolean): void {
    this.initialized = initialized;
  }

  /**
   * LogViewerを設定（遅延初期化用）
   */
  setLogViewer(logViewer: LogViewer | null): void {
    this.logViewer = logViewer;
  }

  /**
   * イベントを記録（fire-and-forget）
   * PoSW計算を待たずに即座に返り、バックグラウンドで処理
   */
  record(event: RecordEventInput): void {
    // 無効化されている場合はスキップ
    if (!this.enabled) {
      return;
    }

    // 初期化完了前のイベント記録をスキップ
    if (!this.initialized) {
      console.debug('[EventRecorder] Skipping event - not initialized');
      return;
    }

    const activeProof = this.tabManager.getActiveProof();
    if (!activeProof) {
      return;
    }

    activeProof
      .recordEvent(event)
      .then((result) => {
        // ログビューアに追加（非同期）
        if (this.logViewer?.isVisible) {
          const recordedEvent = activeProof.events[result.index];
          if (recordedEvent) {
            this.logViewer.addLogEntry(recordedEvent, result.index);
          }
        }
        // タブデータを保存
        this.tabManager.saveToStorage();
      })
      .catch((err) => {
        console.error('[EventRecorder] Recording failed:', err);
        // ユーザーに通知（初期化エラーなど重大なエラーの場合）
        if (err instanceof Error && err.message.includes('not initialized')) {
          this.onError?.(t('common.error'));
        }
      })
      .finally(() => {
        // 成功・失敗に関わらずステータスを更新
        this.onStatusUpdate?.();
      });
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.onStatusUpdate = null;
    this.onError = null;
    this.logViewer = null;
  }
}
