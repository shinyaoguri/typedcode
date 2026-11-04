/**
 * SessionStorageService - IndexedDBを使用したセッション永続化
 * タブデータ、イベント、セッションメタデータのCRUD操作を提供
 */

import type {
  StoredEvent,
  TabSwitchEvent,
  SessionMetadata,
  StoredTabData,
  StoredEventData,
  StoredTabSwitchData,
  SessionSummary,
  TabSummary,
  StoredScreenshotData,
  StoredUnprovenContentData,
} from '@typedcode/shared';
import { IndexedDBHelper, settleOnCommit } from './IndexedDBHelper.js';
import { sessionDbName } from '../core/storageKeys.js';
import { sortTabSwitchesByAppendOrder } from './tabSwitchOrder.js';

// Re-export types for convenience
export type { SessionMetadata, StoredTabData, StoredEventData, StoredTabSwitchData, SessionSummary, TabSummary };

// DB 名はモード別に名前空間化する (ADR-0011 PR3): casual=typedcode-session、他は -<mode>。
// storageKeys.sessionDbName() を使用時 (initialize) に呼ぶ — main.ts が最初期に NS を確定する。
// 2 → 3: unprovenContents ストアを追加 (#413。既存のストアと行は変えない)
const DB_VERSION = 3;

// Object Store Names
const STORE_SESSIONS = 'sessions';
const STORE_TABS = 'tabs';
const STORE_EVENTS = 'events';
const STORE_TAB_SWITCHES = 'tabSwitches';
const STORE_SCREENSHOTS = 'screenshots';
/** 復元時に証明と食い違った元の content (追記のみ。#413) */
const STORE_UNPROVEN_CONTENTS = 'unprovenContents';

// Schema version for data format (use the shared constant)
export const SESSION_STORAGE_VERSION = 1;

// ============================================================================
// Errors (#484 / #237)
// ============================================================================

/**
 * 同じタブ・同じ seq に、保存済みとは別の hash のイベントを書こうとした (二重インスタンスの乖離)。
 * 呼び出し側は「保存層が拒否した」と他のストレージ失敗 (quota 等) から区別できる。
 */
export class EventChainConflictError extends Error {
  constructor(
    readonly tabId: string,
    readonly eventIndex: number,
    readonly storedHash: string,
    readonly attemptedHash: string
  ) {
    super(
      `Event chain conflict on tab ${tabId} at sequence ${eventIndex}: ` +
        `stored hash differs from the attempted one (another instance wrote this session)`
    );
    this.name = 'EventChainConflictError';
  }
}

/** このインスタンスが握っていたセッションを、別のインスタンスが resumeSession した (別インスタンスに再開された)。 */
export class SessionOwnershipError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} was resumed by another instance`);
    this.name = 'SessionOwnershipError';
  }
}

/**
 * open が `blocked` を受けた (#325)。別のタブが旧版の接続を握ったまま閉じないので、スキーマを上げられない。
 * 待ち続けると起動が止まるので即 reject する。呼び出し側は「他の TypedCode のタブを閉じて再読み込み」を案内できる。
 */
export class SessionStorageBlockedError extends Error {
  constructor() {
    super('IndexedDB open was blocked by another connection that did not close (another TypedCode tab may be open)');
    this.name = 'SessionStorageBlockedError';
  }
}

/** 接続を失った理由。`versionchange` = 新しい版が別のタブで開かれた、`closed` = 強制 close の後の再オープンに失敗した */
export type SessionStorageLostReason = 'versionchange' | 'closed';

/** 接続を失った後の操作 (#325)。再読み込みするまで保存先は使えない。 */
export class SessionStorageUnavailableError extends Error {
  constructor(readonly reason: SessionStorageLostReason) {
    super(`IndexedDB connection is unavailable (${reason}); reload the page to reconnect`);
    this.name = 'SessionStorageUnavailableError';
  }
}

// ============================================================================
// Service Implementation
// ============================================================================

export class SessionStorageService {
  private db: IDBDatabase | null = null;
  /**
   * 接続を失っても (versionchange / 再オープンの失敗) 落とさない (#325)。`TabManager.saveToIndexedDB` は
   * 未初期化なら黙って成功扱いにするので、ここを落とすと保存の失敗が `synced` に見える。
   */
  private initialized = false;
  private sessionId: string | null = null;
  private instanceId: string;
  /** 接続を失った理由。立つと以後の操作は `SessionStorageUnavailableError` で reject する */
  private lost: SessionStorageLostReason | null = null;
  /**
   * 全メソッドが db を受け取る前に待つ Promise (reject しない)。普段は解決済みで、強制 close の後は
   * 再オープンの試みに差し替わる。全メソッドがこの 1 本に `.then` を連ねるので、呼び出し順が
   * transaction の作成順として保たれる (IndexedDB の書き込みは逐次 = 不変条件 5)
   */
  private connectionReady: Promise<void> = Promise.resolve();
  /** `close()` のたびに進める。close 後に終わった再オープンの結果を採用しないため */
  private generation = 0;
  private onConnectionLost: ((reason: SessionStorageLostReason) => void) | null = null;

  constructor() {
    this.instanceId = crypto.randomUUID();
  }

  /**
   * IndexedDBを初期化
   *
   * open が `blocked` を受けたら `SessionStorageBlockedError` で即 reject する (#325)。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = await this.openDatabase();
    this.db = db;
    this.attachConnectionHandlers(db);
    this.initialized = true;
    console.log('[SessionStorage] Database initialized');
  }

  /**
   * 接続を失ったとき (versionchange / 強制 close の後の再オープン失敗) に呼ぶリスナーを設定する (#325)。
   * 保存の失敗表示は呼び出し側の既存の経路 (書き込みの reject) に任せ、ここは再読み込みの案内に使う。
   */
  setOnConnectionLost(callback: ((reason: SessionStorageLostReason) => void) | null): void {
    this.onConnectionLost = callback;
  }

  /**
   * session DB を開く。`blocked` は待たずに reject し、その後に遅れて success した接続は close して握らない
   * (握ると、待たせていた側の旧接続と同じく次の版の open を塞ぐ)。
   */
  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(sessionDbName(), DB_VERSION);

      request.onerror = () => {
        if (settled) return;
        settled = true;
        console.error('[SessionStorage] Failed to open database:', request.error);
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onblocked = () => {
        if (settled) return;
        settled = true;
        const error = new SessionStorageBlockedError();
        console.error('[SessionStorage]', error.message);
        reject(error);
      };

      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          // blocked で reject 済み: 遅れて開いた接続は使わない
          db.close();
          return;
        }
        settled = true;
        resolve(db);
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

        // Version 2 → 3: unprovenContents ストア追加 (#413)。既存のストアと行には触らない
        if (oldVersion >= 1 && oldVersion < 3) {
          this.createUnprovenContentsStore(db);
        }
      };
    });
  }

  /**
   * 開いた接続に、接続を失う 2 つの経路のハンドラを張る (#325)。
   * - `versionchange`: 別のタブが新しい版を開こうとしている (か DB を消そうとしている)。閉じないと相手が
   *   blocked で止まるので閉じ、以後の操作は `SessionStorageUnavailableError('versionchange')` にする
   * - `close`: サイトデータの削除などで強制的に閉じられた (自分の `close()` では発火しない)。
   *   再オープンを 1 回だけ試み、失敗したら `SessionStorageUnavailableError('closed')` にする
   */
  private attachConnectionHandlers(db: IDBDatabase): void {
    db.onversionchange = () => {
      if (this.db !== db) return;
      this.detachConnectionHandlers(db);
      db.close();
      this.db = null;
      console.warn('[SessionStorage] Database closed for a newer version opened elsewhere');
      this.markLost('versionchange');
    };
    db.onclose = () => {
      if (this.db !== db) return;
      this.detachConnectionHandlers(db);
      this.db = null;
      console.warn('[SessionStorage] Database connection was closed unexpectedly; reopening once');
      this.reopen();
    };
  }

  private detachConnectionHandlers(db: IDBDatabase): void {
    db.onversionchange = null;
    db.onclose = null;
  }

  /** 強制 close の後に 1 回だけ開き直す。待っている操作は `connectionReady` 経由でこの結果を待つ */
  private reopen(): void {
    const generation = this.generation;
    this.connectionReady = this.openDatabase().then(
      (db) => {
        if (generation !== this.generation) {
          // 再オープン中に close() された: 採用しない
          db.close();
          return;
        }
        this.db = db;
        this.attachConnectionHandlers(db);
        console.log('[SessionStorage] Database reopened');
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        console.error('[SessionStorage] Failed to reopen database:', error);
        this.markLost('closed');
      }
    );
  }

  private markLost(reason: SessionStorageLostReason): void {
    if (this.lost) return;
    this.lost = reason;
    this.onConnectionLost?.(reason);
  }

  /**
   * 操作に使う接続を返す。再オープン中ならその結果を待ち、接続を失った後は `SessionStorageUnavailableError`、
   * 未初期化なら `Database not initialized` で reject する。
   *
   * 全メソッドが同じ深さでここを経てから transaction を作る (呼び出し順 = 作成順。不変条件 5)。
   */
  private getDb(): Promise<IDBDatabase> {
    return this.connectionReady.then(() => {
      if (this.lost) throw new SessionStorageUnavailableError(this.lost);
      if (!this.db) throw new Error('Database not initialized');
      return this.db;
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

    // Unproven contents store (Version 3で追加、新規DBでも作成)
    this.createUnprovenContentsStore(db);
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

  /**
   * Unproven contents Object Storeを作成（マイグレーション用。#413）
   */
  private createUnprovenContentsStore(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(STORE_UNPROVEN_CONTENTS)) {
      const store = db.createObjectStore(STORE_UNPROVEN_CONTENTS, { keyPath: 'id', autoIncrement: true });
      store.createIndex('tabId', 'tabId', { unique: false });
      console.log('[SessionStorage] Unproven contents store created');
    }
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * 既存のセッションが存在するかチェック
   */
  async hasExistingSession(): Promise<boolean> {
    const session = await this.getLatestSession();
    if (!session) return false;

    // タブが存在するかチェック
    const tabCount = await this.getTabCount(session.sessionId);
    return tabCount > 0;
  }

  /**
   * 最新のセッションを取得
   */
  async getLatestSession(): Promise<SessionMetadata | null> {
    const db = await this.getDb();
    return IndexedDBHelper.getLatestByIndex<SessionMetadata>(db, STORE_SESSIONS, 'createdAt');
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
    const db = await this.getDb();

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
      const transaction = db.transaction([STORE_SESSIONS], 'readwrite');
      settleOnCommit(
        transaction,
        'Failed to create session',
        () => {
          this.sessionId = session.sessionId;
          console.log('[SessionStorage] Session created:', session.sessionId);
          resolve(session);
        },
        (error) => {
          console.error('[SessionStorage]', error);
          reject(error);
        }
      );
      transaction.objectStore(STORE_SESSIONS).add(session);
    });
  }

  /**
   * 既存のセッションを再開
   */
  async resumeSession(sessionId: string): Promise<SessionMetadata> {
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
    const db = await this.getDb();
    return IndexedDBHelper.get<SessionMetadata>(db, STORE_SESSIONS, sessionId);
  }

  /**
   * セッションを更新
   */
  async updateSession(session: SessionMetadata): Promise<void> {
    const db = await this.getDb();
    await IndexedDBHelper.put(db, STORE_SESSIONS, session);
  }

  /**
   * アクティブタブIDを更新
   */
  async updateActiveTabId(activeTabId: string): Promise<void> {
    // 未初期化なら黙って戻る (従来どおり)。接続を失った後は getSessionById が reject する (#325)
    if (!this.sessionId || !this.initialized) return;

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
    // 未初期化なら黙って戻る (従来どおり)。接続を失った後は getSessionById が reject する (#325)
    if (!this.sessionId || !this.initialized) return;

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
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [STORE_SESSIONS, STORE_TABS, STORE_EVENTS, STORE_TAB_SWITCHES, STORE_SCREENSHOTS],
        'readwrite'
      );

      settleOnCommit(
        transaction,
        'Failed to clear session',
        () => {
          this.sessionId = null;
          console.log('[SessionStorage] All session data cleared');
          resolve();
        },
        (error) => {
          console.error('[SessionStorage]', error);
          reject(error);
        }
      );

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

  /**
   * このインスタンスがセッションの所有者かを確かめる (#484)。
   * 別インスタンスが `resumeSession` すると sessions の instanceId が上書きされるので、
   * 後から再開された側が呼ぶと `SessionOwnershipError` で reject する。
   * appendEvent は所有者を見ない (先に書いた側のイベントは有効のまま。拒否は hash の食い違いだけ)。
   */
  async assertOwner(): Promise<void> {
    if (!this.initialized || !this.sessionId) throw new Error('Database or session not initialized');

    const session = await this.getSessionById(this.sessionId);
    if (!session) throw new Error(`Session not found: ${this.sessionId}`);
    if (session.instanceId !== this.instanceId) {
      throw new SessionOwnershipError(this.sessionId);
    }
  }

  // ============================================================================
  // Tab Operations
  // ============================================================================

  /**
   * タブを保存
   */
  async saveTab(tab: StoredTabData): Promise<void> {
    const db = await this.getDb();
    await IndexedDBHelper.put(db, STORE_TABS, tab);
    console.log('[SessionStorage] Tab saved:', tab.id);
  }

  /**
   * タブを取得
   */
  async getTab(tabId: string): Promise<StoredTabData | null> {
    const db = await this.getDb();
    return IndexedDBHelper.get<StoredTabData>(db, STORE_TABS, tabId);
  }

  /**
   * セッションの全タブを読み込み
   */
  async loadTabs(sessionId: string): Promise<StoredTabData[]> {
    const db = await this.getDb();
    return IndexedDBHelper.getAllByIndex<StoredTabData>(db, STORE_TABS, 'sessionId', sessionId);
  }

  /**
   * タブを削除
   */
  async deleteTab(tabId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_TABS, STORE_EVENTS], 'readwrite');

      settleOnCommit(
        transaction,
        'Failed to delete tab',
        () => {
          console.log('[SessionStorage] Tab deleted:', tabId);
          resolve();
        },
        (error) => {
          console.error('[SessionStorage]', error);
          reject(error);
        }
      );

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
    const db = await this.getDb();
    return IndexedDBHelper.countByIndex(db, STORE_TABS, 'sessionId', sessionId);
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  /**
   * イベントを追加（インクリメンタル書き込み）
   *
   * 同じ (tabId, sequence) が既にある場合 (ConstraintError) は、同じトランザクション内で
   * 保存済みイベントを読み hash を比べる (#484 / #237):
   * - hash が同じ: 冪等に成功扱い。保存の再試行や、EventRecorder と TabManager.saveToIndexedDB の
   *   二重書き込みはここに入る。tabs レコードは書き換えない (古いイベントで currentHash を巻き戻さない)
   * - hash が違う: 同じセッションに別のチェーンを書こうとした二重インスタンスの乖離。
   *   `EventChainConflictError` で reject し、events も tabs も変更しない
   *
   * 新規に追加できたときだけ、同じトランザクションで tabs の最終書き込み位置と currentHash を進める。
   */
  async appendEvent(tabId: string, event: StoredEvent): Promise<void> {
    const sessionId = this.sessionId;
    if (!this.initialized || !sessionId) throw new Error('Database or session not initialized');
    const db = await this.getDb();

    const eventData: StoredEventData = {
      tabId,
      sessionId,
      eventIndex: event.sequence,
      eventData: event,
      writtenAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_EVENTS, STORE_TABS], 'readwrite');
      const eventsStore = transaction.objectStore(STORE_EVENTS);

      // トランザクション完了時にどう終えるか。ConstraintError は preventDefault で中止を防ぐので、
      // 結果は oncomplete で確定させる。request の success の後に transaction が abort されても
      // (容量切れの commit 失敗など) 成功にせず reject する (#543)
      let conflict: EventChainConflictError | null = null;
      let unexpected: Error | null = null;

      settleOnCommit(
        transaction,
        'Failed to append event',
        () => {
          if (conflict) reject(conflict);
          else if (unexpected) reject(unexpected);
          else resolve();
        },
        (error) => {
          console.error('[SessionStorage]', error);
          reject(error);
        }
      );

      const addRequest = eventsStore.add(eventData);

      addRequest.onsuccess = () => {
        // 新規に書けたので、タブの最終書き込みインデックスを更新
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
      };

      addRequest.onerror = (e) => {
        const error = (e.target as IDBRequest).error;
        if (error?.name !== 'ConstraintError') return; // それ以外はトランザクションごと失敗させる

        e.preventDefault(); // トランザクションの中止を防ぐ
        e.stopPropagation();

        // 保存済みイベントを同じトランザクションで読んで hash を比べる
        const getExisting = eventsStore.index('tabId_eventIndex').get([tabId, event.sequence]);
        getExisting.onsuccess = () => {
          const stored = getExisting.result as StoredEventData | undefined;
          if (!stored) {
            unexpected = new Error('Failed to append event: constraint violated but no stored event found');
          } else if (stored.eventData.hash !== event.hash) {
            conflict = new EventChainConflictError(tabId, event.sequence, stored.eventData.hash, event.hash);
          }
          // hash が同じなら何もしない (冪等。tabs は書き換えない)
        };
      };
    });
  }

  /**
   * タブの全イベントを取得
   */
  async getEvents(tabId: string): Promise<StoredEvent[]> {
    const db = await this.getDb();
    const storedEvents = await IndexedDBHelper.getAllByIndex<StoredEventData>(db, STORE_EVENTS, 'tabId', tabId);
    // eventIndexでソートしてeventDataを抽出
    return storedEvents.sort((a, b) => a.eventIndex - b.eventIndex).map((e) => e.eventData);
  }

  /**
   * イベント数を取得
   */
  async getEventCount(tabId: string): Promise<number> {
    const db = await this.getDb();
    return IndexedDBHelper.countByIndex(db, STORE_EVENTS, 'tabId', tabId);
  }

  // ============================================================================
  // Tab Switch Operations
  // ============================================================================

  /**
   * タブ切り替えイベントを保存
   */
  async saveTabSwitch(switchEvent: TabSwitchEvent): Promise<void> {
    const sessionId = this.sessionId;
    if (!this.initialized || !sessionId) throw new Error('Database or session not initialized');
    const db = await this.getDb();

    const data: StoredTabSwitchData = {
      sessionId,
      switchEvent,
    };

    await IndexedDBHelper.add(db, STORE_TAB_SWITCHES, data);
  }

  /**
   * セッションのタブ切り替え履歴を取得
   */
  async getTabSwitches(sessionId: string): Promise<TabSwitchEvent[]> {
    const db = await this.getDb();
    const stored = await IndexedDBHelper.getAllByIndex<StoredTabSwitchData>(
      db,
      STORE_TAB_SWITCHES,
      'sessionId',
      sessionId
    );
    // timestamp はロードごとに 0 起点でリロードをまたぐと単調でないので、追記順 (id) で並べる (#385)
    return sortTabSwitchesByAppendOrder(stored);
  }

  // ============================================================================
  // Unproven Content Operations (#413)
  // ============================================================================

  /**
   * 復元時に証明と食い違った元の content を残す。
   *
   * **追記のみ**: 既存の行を書き換えず、消す操作も持たない (`clearSession` / `deleteTab` も触らない)。
   * tabs の `saveTab` (put) とは別のストアなので、その後の保存やリロードで上書きされない。
   * 消えるのはモードのリセットで DB ごと消すときだけ。保持期間と容量の管理は #317 で扱う。
   */
  async appendUnprovenContent(record: Omit<StoredUnprovenContentData, 'id'>): Promise<void> {
    const db = await this.getDb();
    // id は autoIncrement に任せ、add で書く (put にしない = 既存の行を上書きする経路を持たない)
    await IndexedDBHelper.add(db, STORE_UNPROVEN_CONTENTS, record);
    console.log('[SessionStorage] Unproven content preserved for tab:', record.tabId);
  }

  /**
   * タブの元の content を、残した順 (古い順) に返す。
   */
  async getUnprovenContents(tabId: string): Promise<StoredUnprovenContentData[]> {
    const db = await this.getDb();
    const rows = await IndexedDBHelper.getAllByIndex<StoredUnprovenContentData>(
      db,
      STORE_UNPROVEN_CONTENTS,
      'tabId',
      tabId
    );
    return rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  // ============================================================================
  // Screenshot Operations
  // ============================================================================

  /**
   * スクリーンショットを保存
   */
  async saveScreenshot(screenshot: StoredScreenshotData): Promise<void> {
    const db = await this.getDb();
    await IndexedDBHelper.put(db, STORE_SCREENSHOTS, screenshot);
    console.log('[SessionStorage] Screenshot saved:', screenshot.id);
  }

  /**
   * IDでスクリーンショットを取得
   */
  async getScreenshotById(id: string): Promise<StoredScreenshotData | null> {
    const db = await this.getDb();
    return IndexedDBHelper.get<StoredScreenshotData>(db, STORE_SCREENSHOTS, id);
  }

  /**
   * セッションの全スクリーンショットを取得
   */
  async getScreenshotsBySession(sessionId: string): Promise<StoredScreenshotData[]> {
    const db = await this.getDb();
    const screenshots = await IndexedDBHelper.getAllByIndex<StoredScreenshotData>(
      db,
      STORE_SCREENSHOTS,
      'sessionId',
      sessionId
    );
    // タイムスタンプでソート
    screenshots.sort((a, b) => a.timestamp - b.timestamp);
    return screenshots;
  }

  /**
   * スクリーンショットを削除
   */
  async deleteScreenshot(id: string): Promise<void> {
    const db = await this.getDb();
    await IndexedDBHelper.delete(db, STORE_SCREENSHOTS, id);
    console.log('[SessionStorage] Screenshot deleted:', id);
  }

  /**
   * セッションの全スクリーンショットを削除
   */
  async clearScreenshotsBySession(sessionId: string): Promise<void> {
    const db = await this.getDb();
    await IndexedDBHelper.deleteByIndex(db, STORE_SCREENSHOTS, 'sessionId', sessionId);
    console.log('[SessionStorage] Screenshots cleared for session:', sessionId);
  }

  /**
   * スクリーンショット数を取得
   */
  async getScreenshotCount(sessionId?: string): Promise<number> {
    const db = await this.getDb();
    if (sessionId) {
      return IndexedDBHelper.countByIndex(db, STORE_SCREENSHOTS, 'sessionId', sessionId);
    }
    return IndexedDBHelper.count(db, STORE_SCREENSHOTS);
  }

  // ============================================================================
  // Utility Operations
  // ============================================================================

  /**
   * データベース接続を閉じる (リセット用)。接続を失った状態と再オープン中の試みも片付ける。
   * 自分で閉じるので、再オープンもリスナーの通知も起こさない。
   */
  close(): void {
    const db = this.db;
    if (db) {
      this.detachConnectionHandlers(db);
      db.close();
      console.log('[SessionStorage] Database closed');
    }
    this.generation += 1;
    this.db = null;
    this.initialized = false;
    this.sessionId = null;
    this.lost = null;
    this.connectionReady = Promise.resolve();
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
