/**
 * EventRecorder - 中央イベント記録システム
 * 各種トラッカーからのイベントを受け取り、TypingProofに記録
 *
 * イベントはIndexedDBにインクリメンタルに保存され、
 * ブラウザタブを閉じた後も復旧可能
 */

import type { EventType, RecordEventInput } from '@typedcode/shared';
import type { TabManager, TabState } from '../ui/tabs/TabManager.js';
import type { LogViewer } from '../ui/components/LogViewer.js';
import { t } from '../i18n/index.js';
import { EventPersistence } from './EventPersistence.js';

/**
 * セッション全体のスナップショット型 (#405)。recordToAllTabs に来た最新の 1 件を型ごとに保持し、
 * 後から作ったタブに recordSessionSnapshotTo で流し直す。配列の順が流し直しの順で、
 * casual の起動時タブに載る順 (Phase 5 の recordInitial 群 → Phase 5.5 の opt-out) と揃える。
 * 新しい起動時ワンショットを足すときはここに登録する (登録しないと、起動時にタブが無い
 * class / assignment と 2 個目以降のタブの proof から欠落する)。
 */
const SESSION_SNAPSHOT_EVENT_TYPES: readonly EventType[] = [
  'windowResize',
  'networkStatusChange',
  'environmentProbe',
  'screenShareOptOut',
];

export interface EventRecorderOptions {
  tabManager: TabManager;
  getLogViewer: () => LogViewer | null;
  onStatusUpdate?: () => void;
  onError?: (message: string) => void;
  /**
   * 利用規約同意の termsAccepted イベントを組み立てる (同意が無ければ null)。
   * recordSessionSnapshotTo が、そのタブにまだ無いときだけ先頭に記録する (#405)。
   */
  getTermsAcceptedEvent?: () => RecordEventInput | null;
}

export class EventRecorder {
  private tabManager: TabManager;
  private getLogViewer: () => LogViewer | null;
  private onStatusUpdate: (() => void) | null;
  private onError: ((message: string) => void) | null;
  private getTermsAcceptedEvent: (() => RecordEventInput | null) | null;
  private enabled = true;
  private initialized = false;
  private persistence: EventPersistence;
  /** スナップショット型ごとの最新イベント (#405)。タブが 0 件のときも保持する */
  private sessionSnapshot = new Map<EventType, RecordEventInput>();

  constructor(options: EventRecorderOptions) {
    this.tabManager = options.tabManager;
    this.getLogViewer = options.getLogViewer;
    this.onStatusUpdate = options.onStatusUpdate ?? null;
    this.onError = options.onError ?? null;
    this.getTermsAcceptedEvent = options.getTermsAcceptedEvent ?? null;
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

    // recordEventを呼び出し（内部でqueuedEventCount++が同期的に実行される）
    const recordPromise = activeProof.recordEvent(event);

    // 記録開始時にステータスを更新（queuedEventCount増加後なのでプログレスリングが表示される）
    this.onStatusUpdate?.();

    recordPromise
      .then(async (result) => {
        // 記録に失敗してチェーンに載らなかったイベントは UI / IndexedDB に流さない (#284)
        if (!result.recorded) {
          console.warn('[EventRecorder] Event was not recorded (dropped); skipping LogViewer / IndexedDB');
          return;
        }

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
    console.debug(
      `[EventRecorder] recordToAllTabs called: ${event.type}, enabled=${this.enabled}, initialized=${this.initialized}`
    );

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

    // スナップショット型は、タブ一覧を読むのと同じ同期区間で保持する (#405)。
    // TabManager はタブ登録の直後に同期で recordSessionSnapshotTo を呼ぶので、
    // 同時に作られたタブは「ここで一覧に載る」か「流し直しで受け取る」のどちらか一方になる。
    if (SESSION_SNAPSHOT_EVENT_TYPES.includes(event.type)) {
      this.sessionSnapshot.set(event.type, event);
    }
    // 起動時に opt-out した後でバナーから画面共有を始めたら、opt-out はもう事実ではない。
    // 以降に作るタブへ流し直さない (開始後のタブに「共有しない」と記録してしまう)
    if (event.type === 'screenShareStart') {
      this.sessionSnapshot.delete('screenShareOptOut');
    }

    const allTabs = this.tabManager.getAllTabs();
    if (allTabs.length === 0) {
      console.debug('[EventRecorder] Skipping - no tabs');
      return Promise.resolve();
    }

    console.debug(`[EventRecorder] Recording ${event.type} to ${allTabs.length} tabs`);

    // 全タブに並列で記録
    const promises = allTabs.map((tab) => this.recordToTab(tab, event));

    // 全タブへの記録が完了してから保存（PoSW計算完了後）
    return Promise.all(promises).then(() => {
      this.persistence.saveTabsToSessionStorage(this.tabManager);
    });
  }

  /**
   * セッションのスナップショットを、後から作ったタブ 1 つにだけ記録する (#405)。
   * 起動時ワンショット (termsAccepted・初期 windowResize / networkStatusChange・environmentProbe・
   * screenShareOptOut) は記録した時点にあるタブにしか載らないため、class / assignment
   * (起動時にタブが無い) や 2 個目以降のタブの proof から欠落していた。
   * TabManager.setOnTabCreated から、タブ登録の直後に同期で呼ばれる前提
   * (recordToAllTabs の記録と二重にも漏れにもならない)。
   * @returns そのタブへの記録が完了したらresolveするPromise
   */
  recordSessionSnapshotTo(tab: TabState): Promise<void> {
    if (!this.enabled || !this.initialized) {
      return Promise.resolve();
    }

    const events: RecordEventInput[] = [];
    // termsAccepted は localStorage の同意から作る。既に載っているタブには重ねない
    const termsEvent = this.getTermsAcceptedEvent?.() ?? null;
    if (termsEvent && !tab.typingProof.events.some((e) => e.type === 'termsAccepted')) {
      events.push(termsEvent);
    }
    for (const type of SESSION_SNAPSHOT_EVENT_TYPES) {
      const snapshot = this.sessionSnapshot.get(type);
      if (snapshot) events.push(snapshot);
    }
    if (events.length === 0) {
      return Promise.resolve();
    }

    console.debug(`[EventRecorder] Replaying session snapshot (${events.length} events) to tab ${tab.id}`);

    // recordEvent は呼んだ順にチェーンへ載るので、同期で順に呼べば順序が保たれる
    const promises = events.map((event) => this.recordToTab(tab, event));

    return Promise.all(promises).then(() => {
      this.persistence.saveTabsToSessionStorage(this.tabManager);
    });
  }

  /**
   * 1 タブにイベントを記録する (recordToAllTabs / recordSessionSnapshotTo の共通処理)。
   * アクティブタブの場合のみ LogViewer に反映し、失敗はログに出して resolve する。
   */
  private recordToTab(tab: TabState, event: RecordEventInput): Promise<void> {
    const recordPromise = tab.typingProof.recordEvent(event);

    // 記録開始時にステータスを更新
    this.onStatusUpdate?.();

    return recordPromise
      .then((result) => {
        // 記録に失敗してチェーンに載らなかったイベントは UI に流さない (#284)
        if (!result.recorded) return;

        // アクティブタブの場合のみログビューアに追加
        const activeTab = this.tabManager.getActiveTab();
        const isActive = activeTab && activeTab.id === tab.id;
        const logViewer = this.getLogViewer();
        const logViewerVisible = logViewer?.isVisible ?? false;

        console.debug(
          `[EventRecorder] recordToTab result: isActive=${isActive}, logViewerVisible=${logViewerVisible}, eventType=${event.type}`
        );

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
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.onStatusUpdate = null;
    this.onError = null;
  }
}
