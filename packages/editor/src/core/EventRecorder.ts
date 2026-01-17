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
import type { SessionContentRegistry } from './SessionContentRegistry.js';
import { t } from '../i18n/index.js';
import { EventPersistence } from './EventPersistence.js';

export interface EventRecorderOptions {
  tabManager: TabManager;
  getLogViewer: () => LogViewer | null;
  contentRegistry?: SessionContentRegistry;
  onStatusUpdate?: () => void;
  onError?: (message: string) => void;
}

export class EventRecorder {
  private tabManager: TabManager;
  private getLogViewer: () => LogViewer | null;
  private contentRegistry: SessionContentRegistry | null;
  private onStatusUpdate: (() => void) | null;
  private onError: ((message: string) => void) | null;
  private enabled = true;
  private initialized = false;
  private persistence: EventPersistence;

  constructor(options: EventRecorderOptions) {
    this.tabManager = options.tabManager;
    this.getLogViewer = options.getLogViewer;
    this.contentRegistry = options.contentRegistry ?? null;
    this.onStatusUpdate = options.onStatusUpdate ?? null;
    this.onError = options.onError ?? null;
    this.persistence = new EventPersistence();
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

    const activeTab = this.tabManager.getActiveTab();
    const activeProof = this.tabManager.getActiveProof();
    if (!activeProof || !activeTab) {
      return;
    }

    // イベント発生時のtabIdをキャプチャ
    // PoSW計算完了後にアクティブタブが変わっている可能性があるため、
    // ここでtabIdを保存しておく（クロージャでキャプチャ）
    const capturedTabId = activeTab.id;

    // contentChange イベントの場合、入力されたコンテンツをレジストリに登録
    // これにより、後でペーストされた時に内部コンテンツかどうかを判定できる
    if (event.type === 'contentChange' && typeof event.data === 'string' && this.contentRegistry) {
      this.contentRegistry.registerContent(event.data);
    }

    // recordEventを呼び出し（内部でqueuedEventCount++が同期的に実行される）
    const recordPromise = activeProof.recordEvent(event);

    // 記録開始時にステータスを更新（queuedEventCount増加後なのでプログレスリングが表示される）
    this.onStatusUpdate?.();

    recordPromise
      .then(async (result) => {
        const recordedEvent = activeProof.events[result.index];

        // ログビューアに追加（非同期）
        const logViewer = this.getLogViewer();
        if (logViewer?.isVisible && recordedEvent) {
          logViewer.addLogEntry(recordedEvent, result.index);
        }

        // IndexedDBにイベントをインクリメンタルに保存
        // イベント発生時にキャプチャしたtabIdを使用（現在のアクティブタブではなく）
        if (recordedEvent) {
          try {
            await this.persistence.saveEventToIndexedDB(capturedTabId, recordedEvent);
          } catch {
            // エラーはEventPersistence内でログ出力済み
          }
        }

        // タブデータを保存（sessionStorage用）
        this.persistence.saveTabsToSessionStorage(this.tabManager);
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
          const logViewer = this.getLogViewer();
          const logViewerVisible = logViewer?.isVisible ?? false;

          console.debug(`[EventRecorder] recordToAllTabs result: isActive=${isActive}, logViewerVisible=${logViewerVisible}, eventType=${event.type}`);

          if (isActive && logViewerVisible && logViewer) {
            const recordedEvent = tab.typingProof.events[result.index];
            if (recordedEvent) {
              logViewer.addLogEntry(recordedEvent, result.index);
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
      this.persistence.saveTabsToSessionStorage(this.tabManager);
    });
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.onStatusUpdate = null;
    this.onError = null;
  }
}
