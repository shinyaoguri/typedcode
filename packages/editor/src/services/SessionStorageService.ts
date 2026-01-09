/**
 * SessionStorageService - IndexedDBを使用したセッション永続化
 * タブデータ、イベント、セッションメタデータのCRUD操作を提供
 */

import {
  type StoredEvent,
  type TabSwitchEvent,
  type SessionMetadata,
  type StoredTabData,
  type StoredEventData,
  type StoredTabSwitchData,
  type SessionSummary,
  type TabSummary,
  type StoredScreenshotData,
} from '@typedcode/shared';

// Re-export types for convenience
export type {
  SessionMetadata,
  StoredTabData,
  StoredEventData,
  StoredTabSwitchData,
  SessionSummary,
  TabSummary,
};

const DB_NAME = 'typedcode-session';
const DB_VERSION = 2;

// Object Store Names
const STORE_SESSIONS = 'sessions';
const STORE_TABS = 'tabs';
const STORE_EVENTS = 'events';
const STORE_TAB_SWITCHES = 'tabSwitches';
const STORE_SCREENSHOTS = 'screenshots';

// Schema version for data format (use the shared constant)
export const SESSION_STORAGE_VERSION = 1;

// ============================================================================
// Service Implementation
// ============================================================================

export class SessionStorageService {
  private db: IDBDatabase | null = null;
  private initialized = false;
  private sessionId: string | null = null;
  private instanceId: string;

  constructor() {
    this.instanceId = crypto.randomUUID();
  }

  /**
   * IndexedDBを初期化
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to open database:', request.error);
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        console.log('[SessionStorage] Database initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        // Version 0 → 1: 初期構造作成
        if (oldVersion < 1) {
          this.createObjectStores(db);
        }

        // Version 1 → 2: Screenshots ストア追加
        if (oldVersion >= 1 && oldVersion < 2) {
          this.createScreenshotsStore(db);
        }
      };
    });
  }

  /**
   * Object Storeを作成
   */
  private createObjectStores(db: IDBDatabase): void {
    // Sessions store
    if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
      const sessionsStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
      sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
      sessionsStore.createIndex('isActive', 'isActive', { unique: false });
      console.log('[SessionStorage] Sessions store created');
    }

    // Tabs store
    if (!db.objectStoreNames.contains(STORE_TABS)) {
      const tabsStore = db.createObjectStore(STORE_TABS, { keyPath: 'id' });
      tabsStore.createIndex('sessionId', 'sessionId', { unique: false });
      tabsStore.createIndex('lastModifiedAt', 'lastModifiedAt', { unique: false });
      console.log('[SessionStorage] Tabs store created');
    }

    // Events store
    if (!db.objectStoreNames.contains(STORE_EVENTS)) {
      const eventsStore = db.createObjectStore(STORE_EVENTS, { keyPath: 'id', autoIncrement: true });
      eventsStore.createIndex('tabId', 'tabId', { unique: false });
      eventsStore.createIndex('sessionId', 'sessionId', { unique: false });
      eventsStore.createIndex('tabId_eventIndex', ['tabId', 'eventIndex'], { unique: true });
      eventsStore.createIndex('writtenAt', 'writtenAt', { unique: false });
      console.log('[SessionStorage] Events store created');
    }

    // Tab switches store
    if (!db.objectStoreNames.contains(STORE_TAB_SWITCHES)) {
      const switchesStore = db.createObjectStore(STORE_TAB_SWITCHES, { keyPath: 'id', autoIncrement: true });
      switchesStore.createIndex('sessionId', 'sessionId', { unique: false });
      switchesStore.createIndex('timestamp', 'switchEvent.timestamp', { unique: false });
      console.log('[SessionStorage] Tab switches store created');
    }

    // Screenshots store (Version 2で追加、新規DBでも作成)
    this.createScreenshotsStore(db);
  }

  /**
   * Screenshots Object Storeを作成（マイグレーション用）
   */
  private createScreenshotsStore(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(STORE_SCREENSHOTS)) {
      const screenshotsStore = db.createObjectStore(STORE_SCREENSHOTS, { keyPath: 'id' });
      screenshotsStore.createIndex('sessionId', 'sessionId', { unique: false });
      screenshotsStore.createIndex('timestamp', 'timestamp', { unique: false });
      screenshotsStore.createIndex('eventSequence', 'eventSequence', { unique: false });
      console.log('[SessionStorage] Screenshots store created');
    }
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * 既存のセッションが存在するかチェック
   */
  async hasExistingSession(): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    const session = await this.getLatestSession();
    if (!session) return false;

    // セッションが非アクティブなら復旧可能
    if (!session.isActive) return true;

    // アクティブセッションがある場合、タブが存在するかチェック
    const tabCount = await this.getTabCount(session.sessionId);
    return tabCount > 0;
  }

  /**
   * 最新のセッションがアクティブかどうかチェック
   * リロード時はアクティブ、タブを閉じた後は非アクティブ
   */
  async isSessionActive(): Promise<boolean> {
    const session = await this.getLatestSession();
    return session?.isActive ?? false;
  }

  /**
   * 最新のセッションを取得
   */
  async getLatestSession(): Promise<SessionMetadata | null> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SESSIONS], 'readonly');
      const store = transaction.objectStore(STORE_SESSIONS);
      const index = store.index('createdAt');
      const request = index.openCursor(null, 'prev'); // 降順で最新を取得

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get latest session:', request.error);
        reject(new Error('Failed to get latest session'));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? cursor.value : null);
      };
    });
  }

  /**
   * セッションサマリーを取得（復旧ダイアログ用）
   */
  async getSessionSummary(): Promise<SessionSummary | null> {
    const session = await this.getLatestSession();
    if (!session) return null;

    const tabs = await this.loadTabs(session.sessionId);
    const tabSummaries: TabSummary[] = [];

    for (const tab of tabs) {
      const eventCount = await this.getEventCount(tab.id);
      tabSummaries.push({
        id: tab.id,
        filename: tab.filename,
        language: tab.language,
        eventCount,
        lastModifiedAt: tab.lastModifiedAt,
      });
    }

    return {
      sessionId: session.sessionId,
      lastActiveAt: session.lastActiveAt,
      createdAt: session.createdAt,
      tabs: tabSummaries,
    };
  }

  /**
   * 新しいセッションを作成
   */
  async createSession(): Promise<SessionMetadata> {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const session: SessionMetadata = {
      sessionId: crypto.randomUUID(),
      createdAt: now,
      lastActiveAt: now,
      version: SESSION_STORAGE_VERSION,
      isActive: true,
      instanceId: this.instanceId,
      activeTabId: '',
      tabOrder: [],
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SESSIONS], 'readwrite');
      const store = transaction.objectStore(STORE_SESSIONS);
      const request = store.add(session);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to create session:', request.error);
        reject(new Error('Failed to create session'));
      };

      request.onsuccess = () => {
        this.sessionId = session.sessionId;
        console.log('[SessionStorage] Session created:', session.sessionId);
        resolve(session);
      };
    });
  }

  /**
   * 既存のセッションを再開
   */
  async resumeSession(sessionId: string): Promise<SessionMetadata> {
    if (!this.db) throw new Error('Database not initialized');

    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // セッションをアクティブに更新
    session.isActive = true;
    session.instanceId = this.instanceId;
    session.lastActiveAt = Date.now();

    await this.updateSession(session);
    this.sessionId = sessionId;

    console.log('[SessionStorage] Session resumed:', sessionId);
    return session;
  }

  /**
   * セッションIDでセッションを取得
   */
  private async getSessionById(sessionId: string): Promise<SessionMetadata | null> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SESSIONS], 'readonly');
      const store = transaction.objectStore(STORE_SESSIONS);
      const request = store.get(sessionId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get session:', request.error);
        reject(new Error('Failed to get session'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  /**
   * セッションを更新
   */
  async updateSession(session: SessionMetadata): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SESSIONS], 'readwrite');
      const store = transaction.objectStore(STORE_SESSIONS);
      const request = store.put(session);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to update session:', request.error);
        reject(new Error('Failed to update session'));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * セッションアクティビティを更新（ハートビート）
   */
  async updateSessionActivity(): Promise<void> {
    if (!this.sessionId || !this.db) return;

    const session = await this.getSessionById(this.sessionId);
    if (!session) return;

    session.lastActiveAt = Date.now();
    await this.updateSession(session);
  }

  /**
   * セッションを非アクティブにマーク
   */
  async markSessionInactive(): Promise<void> {
    if (!this.sessionId || !this.db) return;

    try {
      const session = await this.getSessionById(this.sessionId);
      if (!session) return;

      session.isActive = false;
      session.lastActiveAt = Date.now();
      await this.updateSession(session);
      console.log('[SessionStorage] Session marked inactive:', this.sessionId);
    } catch (error) {
      console.error('[SessionStorage] Failed to mark session inactive:', error);
    }
  }

  /**
   * アクティブタブIDを更新
   */
  async updateActiveTabId(activeTabId: string): Promise<void> {
    if (!this.sessionId || !this.db) return;

    const session = await this.getSessionById(this.sessionId);
    if (!session) return;

    session.activeTabId = activeTabId;
    session.lastActiveAt = Date.now();
    await this.updateSession(session);
  }

  /**
   * タブ順序を更新
   */
  async updateTabOrder(tabOrder: string[]): Promise<void> {
    if (!this.sessionId || !this.db) return;

    const session = await this.getSessionById(this.sessionId);
    if (!session) return;

    session.tabOrder = tabOrder;
    session.lastActiveAt = Date.now();
    await this.updateSession(session);
  }

  /**
   * セッションを完全にクリア
   */
  async clearSession(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [STORE_SESSIONS, STORE_TABS, STORE_EVENTS, STORE_TAB_SWITCHES, STORE_SCREENSHOTS],
        'readwrite'
      );

      transaction.onerror = () => {
        console.error('[SessionStorage] Failed to clear session:', transaction.error);
        reject(new Error('Failed to clear session'));
      };

      transaction.oncomplete = () => {
        this.sessionId = null;
        console.log('[SessionStorage] All session data cleared');
        resolve();
      };

      // 全てのstoreをクリア
      transaction.objectStore(STORE_SESSIONS).clear();
      transaction.objectStore(STORE_TABS).clear();
      transaction.objectStore(STORE_EVENTS).clear();
      transaction.objectStore(STORE_TAB_SWITCHES).clear();
      transaction.objectStore(STORE_SCREENSHOTS).clear();
    });
  }

  /**
   * 現在のセッションIDを取得
   */
  getCurrentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * 現在のインスタンスIDを取得
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  // ============================================================================
  // Tab Operations
  // ============================================================================

  /**
   * タブを保存
   */
  async saveTab(tab: StoredTabData): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TABS], 'readwrite');
      const store = transaction.objectStore(STORE_TABS);
      const request = store.put(tab);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to save tab:', request.error);
        reject(new Error('Failed to save tab'));
      };

      request.onsuccess = () => {
        console.log('[SessionStorage] Tab saved:', tab.id);
        resolve();
      };
    });
  }

  /**
   * タブを取得
   */
  async getTab(tabId: string): Promise<StoredTabData | null> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TABS], 'readonly');
      const store = transaction.objectStore(STORE_TABS);
      const request = store.get(tabId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get tab:', request.error);
        reject(new Error('Failed to get tab'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  /**
   * セッションの全タブを読み込み
   */
  async loadTabs(sessionId: string): Promise<StoredTabData[]> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TABS], 'readonly');
      const store = transaction.objectStore(STORE_TABS);
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to load tabs:', request.error);
        reject(new Error('Failed to load tabs'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? []);
      };
    });
  }

  /**
   * タブを削除
   */
  async deleteTab(tabId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TABS, STORE_EVENTS], 'readwrite');

      transaction.onerror = () => {
        console.error('[SessionStorage] Failed to delete tab:', transaction.error);
        reject(new Error('Failed to delete tab'));
      };

      transaction.oncomplete = () => {
        console.log('[SessionStorage] Tab deleted:', tabId);
        resolve();
      };

      // タブを削除
      transaction.objectStore(STORE_TABS).delete(tabId);

      // 関連するイベントを削除
      const eventsStore = transaction.objectStore(STORE_EVENTS);
      const index = eventsStore.index('tabId');
      const request = index.openCursor(tabId);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  /**
   * タブ数を取得
   */
  async getTabCount(sessionId: string): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TABS], 'readonly');
      const store = transaction.objectStore(STORE_TABS);
      const index = store.index('sessionId');
      const request = index.count(sessionId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to count tabs:', request.error);
        reject(new Error('Failed to count tabs'));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * タブコンテンツを更新
   */
  async updateTabContent(tabId: string, content: string): Promise<void> {
    const tab = await this.getTab(tabId);
    if (!tab) return;

    tab.content = content;
    tab.lastModifiedAt = Date.now();
    await this.saveTab(tab);
  }

  /**
   * タブメタデータを更新
   */
  async updateTabMetadata(
    tabId: string,
    updates: Partial<Pick<StoredTabData, 'filename' | 'language' | 'verificationState' | 'verificationDetails'>>
  ): Promise<void> {
    const tab = await this.getTab(tabId);
    if (!tab) return;

    Object.assign(tab, updates);
    tab.lastModifiedAt = Date.now();
    await this.saveTab(tab);
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  /**
   * イベントを追加（インクリメンタル書き込み）
   * 既に同じシーケンス番号のイベントが存在する場合はスキップ（リロード時の重複防止）
   */
  async appendEvent(tabId: string, event: StoredEvent): Promise<void> {
    if (!this.db || !this.sessionId) throw new Error('Database or session not initialized');

    const eventData: StoredEventData = {
      tabId,
      sessionId: this.sessionId,
      eventIndex: event.sequence,
      eventData: event,
      writtenAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_EVENTS, STORE_TABS], 'readwrite');

      let eventAddFailed = false;

      transaction.onerror = () => {
        // ConstraintErrorの場合は重複イベントなのでスキップ
        if (eventAddFailed) {
          // イベント追加は失敗したが、それ以外は成功 - 正常終了扱い
          resolve();
          return;
        }
        console.error('[SessionStorage] Failed to append event:', transaction.error);
        reject(new Error('Failed to append event'));
      };

      transaction.oncomplete = () => {
        resolve();
      };

      // イベントを追加
      const addRequest = transaction.objectStore(STORE_EVENTS).add(eventData);

      addRequest.onerror = (e) => {
        // ConstraintError（重複）の場合はエラーを無視
        const error = (e.target as IDBRequest).error;
        if (error?.name === 'ConstraintError') {
          // 重複イベントはスキップ（リロード時に発生する正常なケース）
          eventAddFailed = true;
          e.preventDefault(); // トランザクションの中止を防ぐ
          e.stopPropagation();
          return;
        }
      };

      // タブの最終書き込みインデックスを更新
      const tabsStore = transaction.objectStore(STORE_TABS);
      const getRequest = tabsStore.get(tabId);

      getRequest.onsuccess = () => {
        const tab = getRequest.result as StoredTabData | undefined;
        if (tab) {
          tab.lastWrittenEventIndex = event.sequence;
          tab.currentHash = event.hash;
          tab.lastModifiedAt = Date.now();
          tabsStore.put(tab);
        }
      };
    });
  }

  /**
   * タブの全イベントを取得
   */
  async getEvents(tabId: string): Promise<StoredEvent[]> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_EVENTS], 'readonly');
      const store = transaction.objectStore(STORE_EVENTS);
      const index = store.index('tabId');
      const request = index.getAll(tabId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get events:', request.error);
        reject(new Error('Failed to get events'));
      };

      request.onsuccess = () => {
        const storedEvents = request.result as StoredEventData[];
        // eventIndexでソートしてeventDataを抽出
        const events = storedEvents
          .sort((a, b) => a.eventIndex - b.eventIndex)
          .map(e => e.eventData);
        resolve(events);
      };
    });
  }

  /**
   * イベント数を取得
   */
  async getEventCount(tabId: string): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_EVENTS], 'readonly');
      const store = transaction.objectStore(STORE_EVENTS);
      const index = store.index('tabId');
      const request = index.count(tabId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to count events:', request.error);
        reject(new Error('Failed to count events'));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * 指定インデックス以降のイベントを切り詰め（破損回復用）
   */
  async truncateEvents(tabId: string, fromIndex: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_EVENTS], 'readwrite');
      const store = transaction.objectStore(STORE_EVENTS);
      const index = store.index('tabId');
      const request = index.openCursor(tabId);

      transaction.onerror = () => {
        console.error('[SessionStorage] Failed to truncate events:', transaction.error);
        reject(new Error('Failed to truncate events'));
      };

      transaction.oncomplete = () => {
        console.log(`[SessionStorage] Events truncated from index ${fromIndex} for tab ${tabId}`);
        resolve();
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const eventData = cursor.value as StoredEventData;
          if (eventData.eventIndex >= fromIndex) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
    });
  }

  // ============================================================================
  // Tab Switch Operations
  // ============================================================================

  /**
   * タブ切り替えイベントを保存
   */
  async saveTabSwitch(switchEvent: TabSwitchEvent): Promise<void> {
    if (!this.db || !this.sessionId) throw new Error('Database or session not initialized');

    const data: StoredTabSwitchData = {
      sessionId: this.sessionId,
      switchEvent,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TAB_SWITCHES], 'readwrite');
      const store = transaction.objectStore(STORE_TAB_SWITCHES);
      const request = store.add(data);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to save tab switch:', request.error);
        reject(new Error('Failed to save tab switch'));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * セッションのタブ切り替え履歴を取得
   */
  async getTabSwitches(sessionId: string): Promise<TabSwitchEvent[]> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_TAB_SWITCHES], 'readonly');
      const store = transaction.objectStore(STORE_TAB_SWITCHES);
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get tab switches:', request.error);
        reject(new Error('Failed to get tab switches'));
      };

      request.onsuccess = () => {
        const stored = request.result as StoredTabSwitchData[];
        const switches = stored
          .map(s => s.switchEvent)
          .sort((a, b) => a.timestamp - b.timestamp);
        resolve(switches);
      };
    });
  }

  // ============================================================================
  // Screenshot Operations
  // ============================================================================

  /**
   * スクリーンショットを保存
   */
  async saveScreenshot(screenshot: StoredScreenshotData): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readwrite');
      const store = transaction.objectStore(STORE_SCREENSHOTS);
      const request = store.put(screenshot);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to save screenshot:', request.error);
        reject(new Error('Failed to save screenshot'));
      };

      request.onsuccess = () => {
        console.log('[SessionStorage] Screenshot saved:', screenshot.id);
        resolve();
      };
    });
  }

  /**
   * IDでスクリーンショットを取得
   */
  async getScreenshotById(id: string): Promise<StoredScreenshotData | null> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readonly');
      const store = transaction.objectStore(STORE_SCREENSHOTS);
      const request = store.get(id);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get screenshot:', request.error);
        reject(new Error('Failed to get screenshot'));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  /**
   * セッションの全スクリーンショットを取得
   */
  async getScreenshotsBySession(sessionId: string): Promise<StoredScreenshotData[]> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readonly');
      const store = transaction.objectStore(STORE_SCREENSHOTS);
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to get screenshots:', request.error);
        reject(new Error('Failed to get screenshots'));
      };

      request.onsuccess = () => {
        const screenshots = request.result as StoredScreenshotData[];
        // タイムスタンプでソート
        screenshots.sort((a, b) => a.timestamp - b.timestamp);
        resolve(screenshots);
      };
    });
  }

  /**
   * スクリーンショットを削除
   */
  async deleteScreenshot(id: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readwrite');
      const store = transaction.objectStore(STORE_SCREENSHOTS);
      const request = store.delete(id);

      request.onerror = () => {
        console.error('[SessionStorage] Failed to delete screenshot:', request.error);
        reject(new Error('Failed to delete screenshot'));
      };

      request.onsuccess = () => {
        console.log('[SessionStorage] Screenshot deleted:', id);
        resolve();
      };
    });
  }

  /**
   * セッションの全スクリーンショットを削除
   */
  async clearScreenshotsBySession(sessionId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readwrite');
      const store = transaction.objectStore(STORE_SCREENSHOTS);
      const index = store.index('sessionId');
      const request = index.openCursor(sessionId);

      transaction.onerror = () => {
        console.error('[SessionStorage] Failed to clear screenshots:', transaction.error);
        reject(new Error('Failed to clear screenshots'));
      };

      transaction.oncomplete = () => {
        console.log('[SessionStorage] Screenshots cleared for session:', sessionId);
        resolve();
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  /**
   * スクリーンショット数を取得
   */
  async getScreenshotCount(sessionId?: string): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SCREENSHOTS], 'readonly');
      const store = transaction.objectStore(STORE_SCREENSHOTS);

      let request: IDBRequest<number>;
      if (sessionId) {
        const index = store.index('sessionId');
        request = index.count(sessionId);
      } else {
        request = store.count();
      }

      request.onerror = () => {
        console.error('[SessionStorage] Failed to count screenshots:', request.error);
        reject(new Error('Failed to count screenshots'));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  // ============================================================================
  // Utility Operations
  // ============================================================================

  /**
   * 古いセッションを削除（容量管理）
   */
  async pruneOldSessions(keepCount: number = 1): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SESSIONS], 'readonly');
      const store = transaction.objectStore(STORE_SESSIONS);
      const index = store.index('createdAt');
      const request = index.getAll();

      request.onerror = () => {
        reject(new Error('Failed to get sessions for pruning'));
      };

      request.onsuccess = async () => {
        const sessions = request.result as SessionMetadata[];

        // 古い順にソート
        sessions.sort((a, b) => a.createdAt - b.createdAt);

        // 削除対象を決定
        const toDelete = sessions.slice(0, Math.max(0, sessions.length - keepCount));
        let deletedCount = 0;

        for (const session of toDelete) {
          // 現在のセッションはスキップ
          if (session.sessionId === this.sessionId) continue;

          try {
            await this.deleteSessionById(session.sessionId);
            deletedCount++;
          } catch (error) {
            console.error(`[SessionStorage] Failed to delete session ${session.sessionId}:`, error);
          }
        }

        console.log(`[SessionStorage] Pruned ${deletedCount} old sessions`);
        resolve(deletedCount);
      };
    });
  }

  /**
   * 特定のセッションを削除
   */
  private async deleteSessionById(sessionId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        [STORE_SESSIONS, STORE_TABS, STORE_EVENTS, STORE_TAB_SWITCHES, STORE_SCREENSHOTS],
        'readwrite'
      );

      transaction.onerror = () => {
        reject(new Error(`Failed to delete session ${sessionId}`));
      };

      transaction.oncomplete = () => {
        resolve();
      };

      // セッションを削除
      transaction.objectStore(STORE_SESSIONS).delete(sessionId);

      // 関連するタブを削除
      const tabsStore = transaction.objectStore(STORE_TABS);
      const tabsIndex = tabsStore.index('sessionId');
      const tabsRequest = tabsIndex.openCursor(sessionId);

      tabsRequest.onsuccess = () => {
        const cursor = tabsRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // 関連するイベントを削除
      const eventsStore = transaction.objectStore(STORE_EVENTS);
      const eventsIndex = eventsStore.index('sessionId');
      const eventsRequest = eventsIndex.openCursor(sessionId);

      eventsRequest.onsuccess = () => {
        const cursor = eventsRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // 関連するタブ切り替えを削除
      const switchesStore = transaction.objectStore(STORE_TAB_SWITCHES);
      const switchesIndex = switchesStore.index('sessionId');
      const switchesRequest = switchesIndex.openCursor(sessionId);

      switchesRequest.onsuccess = () => {
        const cursor = switchesRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // 関連するスクリーンショットを削除
      const screenshotsStore = transaction.objectStore(STORE_SCREENSHOTS);
      const screenshotsIndex = screenshotsStore.index('sessionId');
      const screenshotsRequest = screenshotsIndex.openCursor(sessionId);

      screenshotsRequest.onsuccess = () => {
        const cursor = screenshotsRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  /**
   * データベース接続を閉じる
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      this.sessionId = null;
      console.log('[SessionStorage] Database closed');
    }
  }

  /**
   * 初期化済みかどうか
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
let sessionStorageServiceInstance: SessionStorageService | null = null;

/**
 * SessionStorageServiceのシングルトンインスタンスを取得
 */
export function getSessionStorageService(): SessionStorageService {
  if (!sessionStorageServiceInstance) {
    sessionStorageServiceInstance = new SessionStorageService();
  }
  return sessionStorageServiceInstance;
}

/**
 * SessionStorageServiceを初期化してシングルトンインスタンスを返す
 */
export async function initSessionStorageService(): Promise<SessionStorageService> {
  const service = getSessionStorageService();
  if (!service.isInitialized()) {
    await service.initialize();
  }
  return service;
}

/**
 * SessionStorageServiceをリセット（テスト用）
 */
export function resetSessionStorageService(): void {
  if (sessionStorageServiceInstance) {
    sessionStorageServiceInstance.close();
    sessionStorageServiceInstance = null;
  }
}
