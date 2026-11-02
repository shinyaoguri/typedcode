/**
 * EventPersistence - イベント永続化サービス
 *
 * イベントのIndexedDB保存とsessionStorage保存を担当
 */

import type { StoredEvent } from '@typedcode/shared';
import type { TabManager } from '../ui/tabs/TabManager.js';
import { getSessionStorageService, EventChainConflictError } from '../services/SessionStorageService.js';

export class EventPersistence {
  /**
   * イベントをIndexedDBに保存
   */
  async saveEventToIndexedDB(tabId: string, event: StoredEvent): Promise<void> {
    try {
      const sessionService = getSessionStorageService();
      if (sessionService.isInitialized() && sessionService.getCurrentSessionId()) {
        await sessionService.appendEvent(tabId, event);
      }
    } catch (e) {
      if (e instanceof EventChainConflictError) {
        // 二重インスタンスの乖離 (#484 / #237)。保存層が拒否した。検出時の read-only 化・UI は #237 PR-3
        console.error('[EventPersistence] Event rejected: another instance wrote a different chain:', e.message);
        throw e;
      }
      console.error('[EventPersistence] Failed to save event to IndexedDB:', e);
      throw e;
    }
  }

  /**
   * タブデータをsessionStorageに保存
   */
  saveTabsToSessionStorage(tabManager: TabManager): void {
    tabManager.saveToStorage();
  }
}
