/**
 * EventRecorder - 中央イベント記録システム
 * 各種トラッカーからのイベントを受け取り、TypingProofに記録
 *
 * イベントはIndexedDBにインクリメンタルに保存され、
 * ブラウザタブを閉じた後も復旧可能
 */

import type { RecordEventInput } from '@typedcode/shared';
import type { TabManager } from '../ui/tabs/TabManager.js';
import type { LogViewer } from '../ui/components/LogViewer.js';
import { t } from '../i18n/index.js';
import { getSessionStorageService } from '../services/SessionStorageService.js';

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

    // recordEventを呼び出し（内部でqueuedEventCount++が同期的に実行される）
    const recordPromise = activeProof.recordEvent(event);

    // 記録開始時にステータスを更新（queuedEventCount増加後なのでプログレスリングが表示される）
    this.onStatusUpdate?.();

    recordPromise
      .then(async (result) => {
        const recordedEvent = activeProof.events[result.index];

        // ログビューアに追加（非同期）
        if (this.logViewer?.isVisible && recordedEvent) {
          this.logViewer.addLogEntry(recordedEvent, result.index);
        }

        // IndexedDBにイベントをインクリメンタルに保存
        const activeTab = this.tabManager.getActiveTab();
        if (recordedEvent && activeTab) {
          try {
            const sessionService = getSessionStorageService();
            if (sessionService.isInitialized() && sessionService.getCurrentSessionId()) {
              await sessionService.appendEvent(activeTab.id, recordedEvent);
            }
          } catch (e) {
            console.error('[EventRecorder] Failed to save event to IndexedDB:', e);
          }
        }

        // タブデータを保存（sessionStorage用）
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
   * 全タブにイベントを記録
   * スクリーンショット関連などセッション全体に関わるイベント用
   * タブが削除されてもイベントが失われないようにする
   * @returns 全タブへの記録が完了したらresolveするPromise
   */
  recordToAllTabs(event: RecordEventInput): Promise<void> {
    console.debug(`[EventRecorder] recordToAllTabs called: ${event.type}, enabled=${this.enabled}, initialized=${this.initialized}`);

    // 無効化されている場合はスキップ
    if (!this.enabled) {
      console.debug('[EventRecorder] Skipping - not enabled');
      return Promise.resolve();
    }

    // 初期化完了前のイベント記録をスキップ
    if (!this.initialized) {
      console.debug('[EventRecorder] Skipping event - not initialized');
      return Promise.resolve();
    }

    const allTabs = this.tabManager.getAllTabs();
    if (allTabs.length === 0) {
      console.debug('[EventRecorder] Skipping - no tabs');
      return Promise.resolve();
    }

    console.debug(`[EventRecorder] Recording ${event.type} to ${allTabs.length} tabs`);

    // 全タブに並列で記録
    const promises = allTabs.map((tab) => {
      const recordPromise = tab.typingProof.recordEvent(event);

      // 記録開始時にステータスを更新
      this.onStatusUpdate?.();

      return recordPromise
        .then((result) => {
          // アクティブタブの場合のみログビューアに追加
          const activeTab = this.tabManager.getActiveTab();
          const isActive = activeTab && activeTab.id === tab.id;
          const logViewerVisible = this.logViewer?.isVisible ?? false;

          console.debug(`[EventRecorder] recordToAllTabs result: isActive=${isActive}, logViewerVisible=${logViewerVisible}, eventType=${event.type}`);

          if (isActive && logViewerVisible) {
            const recordedEvent = tab.typingProof.events[result.index];
            if (recordedEvent) {
              this.logViewer!.addLogEntry(recordedEvent, result.index);
            }
          }
        })
        .catch((err) => {
          console.error(`[EventRecorder] Recording to tab ${tab.id} failed:`, err);
        })
        .finally(() => {
          this.onStatusUpdate?.();
        });
    });

    // 全タブへの記録が完了してから保存（PoSW計算完了後）
    return Promise.all(promises).then(() => {
      this.tabManager.saveToStorage();
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
