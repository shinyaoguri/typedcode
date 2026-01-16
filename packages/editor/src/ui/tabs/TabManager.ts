/**
 * TabManager - マルチタブ管理システム
 * 複数のタブとそれぞれのハッシュチェーンを管理
 *
 * IndexedDBを使用してセッションデータを永続化し、
 * ブラウザタブを閉じた後も復旧可能にする
 */

import * as monaco from 'monaco-editor';
import { TypingProof, PROOF_FORMAT_VERSION } from '@typedcode/shared';
import type {
  FingerprintComponents,
  TabSwitchEvent,
  SerializedProofState,
  MultiTabStorage,
  LightweightTabState,
  LightweightMultiTabStorage,
  ExportedProof,
  MultiFileExportedProof,
  MultiFileExportEntry,
  HumanAttestationEventData,
  VerificationState,
  VerificationDetails,
  StoredTabData,
} from '@typedcode/shared';
import {
  isTurnstileConfigured,
  type VerificationResult,
} from '../../services/TurnstileService.js';
import { performVerificationWithUI } from './TabVerificationUI.js';
import { t } from '../../i18n/index.js';
import {
  SessionStorageService,
  getSessionStorageService,
} from '../../services/SessionStorageService.js';

// PoSW Workerのファクトリ関数
// Viteがsymlinkedパッケージ内のWorkerを正しく解決できないため、editorパッケージ内から読み込む
function createPoswWorker(): Worker {
  return new Worker(
    new URL('../../workers/poswWorker.ts', import.meta.url),
    { type: 'module' }
  );
}

// Re-export for convenience
export type { VerificationState, VerificationDetails };

/** タブの実行時状態 */
export interface TabState {
  id: string;
  filename: string;
  language: string;
  typingProof: TypingProof;
  model: monaco.editor.ITextModel;
  createdAt: number;
  verificationState: VerificationState;
  verificationDetails?: VerificationDetails;
}

/** タブ変更コールバック */
export type OnTabChangeCallback = (tab: TabState, previousTab: TabState | null) => void;

/** タブ更新コールバック */
export type OnTabUpdateCallback = (tab: TabState) => void;

/** 認証結果コールバック */
export type OnVerificationCallback = (result: VerificationResult) => void;

/** タブ作成オプション */
export interface CreateTabOptions {
  /** sessionStorageからの復元時はtrue（認証不要） */
  skipAttestation?: boolean;
}

/** 言語IDから拡張子を取得 */
function getFileExtension(language: string): string {
  const extensionMap: Record<string, string> = {
    'c': 'c',
    'cpp': 'cpp',
    'javascript': 'js',
    'typescript': 'ts',
    'html': 'html',
    'css': 'css',
    'json': 'json',
    'markdown': 'md',
    'python': 'py'
  };
  return extensionMap[language] ?? 'txt';
}

/** UUID生成 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/** ストレージキー */
const STORAGE_KEY = 'typedcode-tabs';
const OLD_STORAGE_KEYS = ['editorContent', 'editorLanguage', 'editorFilename', 'typingProof'];

export class TabManager {
  private tabs: Map<string, TabState> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private tabSwitches: TabSwitchEvent[] = [];
  private fingerprint: string | null = null;
  private fingerprintComponents: FingerprintComponents | null = null;
  private editor: monaco.editor.IStandaloneCodeEditor;
  private onTabChangeCallback: OnTabChangeCallback | null = null;
  private onTabUpdateCallback: OnTabUpdateCallback | null = null;
  private onVerificationCallback: OnVerificationCallback | null = null;
  private startTime: number = performance.now();
  private sessionService: SessionStorageService;

  /** 現在実行中の保存処理 */
  private currentSavePromise: Promise<void> | null = null;
  /** 次の保存が必要かどうか */
  private needsSave: boolean = false;
  /** デバウンス用タイマー */
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** デバウンス待ち時間（ミリ秒） */
  private static readonly SAVE_DEBOUNCE_MS = 100;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.sessionService = getSessionStorageService();
  }

  /**
   * TabManagerを初期化
   * @returns 初期化成功時はtrue、reCAPTCHA失敗時はfalse
   */
  async initialize(
    fingerprintHash: string,
    fingerprintComponents: FingerprintComponents
  ): Promise<boolean> {
    this.fingerprint = fingerprintHash;
    this.fingerprintComponents = fingerprintComponents;

    // 旧形式のデータを削除
    this.clearOldStorageData();

    // 保存されたタブデータを読み込む
    await this.loadFromStorage();

    // タブがない場合はウェルカム画面を表示するため、デフォルトタブは作成しない
    // 認証はユーザーが新規ファイル作成またはテンプレート読み込みを選択したタイミングで実行
    console.log('[TabManager] initialize() completed, tabs.size:', this.tabs.size);
    return true;
  }

  /**
   * 旧形式のストレージデータを削除
   */
  private clearOldStorageData(): void {
    for (const key of OLD_STORAGE_KEYS) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.log(`[TabManager] Removed old storage key: ${key}`);
      }
    }
  }

  /**
   * タブ変更コールバックを設定
   */
  setOnTabChange(callback: OnTabChangeCallback): void {
    this.onTabChangeCallback = callback;
  }

  /**
   * タブ更新コールバックを設定
   */
  setOnTabUpdate(callback: OnTabUpdateCallback): void {
    this.onTabUpdateCallback = callback;
  }

  /**
   * 認証結果コールバックを設定
   */
  setOnVerification(callback: OnVerificationCallback): void {
    this.onVerificationCallback = callback;
  }

  /**
   * 全タブ閉じた時のコールバックを設定
   */
  private onAllTabsClosedCallback: (() => void) | null = null;

  setOnAllTabsClosed(callback: () => void): void {
    this.onAllTabsClosedCallback = callback;
  }

  /**
   * タブが存在するかどうか
   */
  hasAnyTabs(): boolean {
    return this.tabs.size > 0;
  }

  /**
   * 新しいタブを作成
   * Turnstileが設定されている場合、認証結果をevent #0として記録（成功・失敗問わず）
   * @returns 常にTabState（認証失敗でもタブ作成は続行）
   */
  async createTab(
    filename: string = 'untitled',
    language: string = 'c',
    content: string = '',
    options?: CreateTabOptions
  ): Promise<TabState | null> {
    const id = generateUUID();
    const createdAt = Date.now();

    // TypingProofインスタンスを作成（Workerをeditorパッケージから注入）
    const typingProof = new TypingProof();
    const poswWorker = createPoswWorker();
    await typingProof.initialize(this.fingerprint!, this.fingerprintComponents!, poswWorker);

    // Pending Event変更コールバックを設定（即時保存用）
    typingProof.setOnPendingEventChange(() => {
      this.saveToStorage();
    });

    // 認証状態を追跡
    let verificationState: VerificationState = 'skipped';
    let verificationDetails: VerificationDetails | undefined;

    // Turnstile認証（skipAttestationでない場合のみ）
    if (!options?.skipAttestation && isTurnstileConfigured()) {
      console.log('[TabManager] Performing Turnstile verification for new tab...');

      const uiResult = await performVerificationWithUI('create_tab', t);

      verificationState = uiResult.verificationState;
      verificationDetails = uiResult.verificationDetails;

      // 認証結果をハッシュチェーンに記録（成功・失敗問わず）
      await typingProof.recordHumanAttestation(uiResult.attestationData);

      // コールバックで通知
      this.onVerificationCallback?.(uiResult.result);

      // 注意: 認証失敗でもタブ作成は続行（ブロックしない）
    }

    // Monacoモデルを作成
    const model = monaco.editor.createModel(content, language);

    const tab: TabState = {
      id,
      filename,
      language,
      typingProof,
      model,
      createdAt,
      verificationState,
      verificationDetails,
    };

    this.tabs.set(id, tab);
    this.tabOrder.push(id);

    // 最初のタブまたはアクティブタブがない場合はこのタブをアクティブに
    if (this.activeTabId === null) {
      await this.switchTab(id);
    }

    this.saveToStorage();
    return tab;
  }

  /**
   * タブを閉じる
   */
  closeTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    // モデルを破棄
    tab.model.dispose();

    // タブを削除
    this.tabs.delete(tabId);
    this.tabOrder = this.tabOrder.filter(id => id !== tabId);

    // タブが0になった場合
    if (this.tabs.size === 0) {
      this.activeTabId = null;
      this.saveToStorage();
      // ウェルカム画面表示のコールバックを呼び出し
      this.onAllTabsClosedCallback?.();
      return true;
    }

    // アクティブタブが閉じられた場合、別のタブに切り替え
    if (this.activeTabId === tabId) {
      const remainingTabs = Array.from(this.tabs.keys());
      if (remainingTabs.length > 0) {
        this.switchTab(remainingTabs[0]!);
      }
    } else {
      // アクティブでないタブが閉じられた場合もUIを更新
      if (this.onTabUpdateCallback) {
        const activeTab = this.getActiveTab();
        if (activeTab) {
          this.onTabUpdateCallback(activeTab);
        }
      }
    }

    this.saveToStorage();
    return true;
  }

  /**
   * すべてのタブを閉じる（テンプレートインポート用）
   * 通常のcloseTabと異なり、最後の1つも閉じる
   */
  async closeAllTabs(): Promise<void> {
    // すべてのモデルを破棄
    for (const tab of this.tabs.values()) {
      tab.model.dispose();
    }

    // 状態をクリア
    this.tabs.clear();
    this.tabOrder = [];
    this.activeTabId = null;
    this.tabSwitches = [];

    // ストレージもクリア
    sessionStorage.removeItem(STORAGE_KEY);
  }

  /**
   * テンプレートからタブを作成（Turnstile認証なし）
   * 最初のファイルの認証結果を共有して使用
   * @param filename - ファイル名
   * @param language - 言語ID
   * @param content - 初期コンテンツ
   * @param sharedAttestation - 共有する人間認証データ（最初のファイルから）
   */
  async createTabFromTemplate(
    filename: string,
    language: string,
    content: string,
    sharedAttestation: HumanAttestationEventData | null
  ): Promise<TabState | null> {
    const id = generateUUID();
    const createdAt = Date.now();

    // TypingProofインスタンスを作成
    const typingProof = new TypingProof();
    const poswWorker = createPoswWorker();
    await typingProof.initialize(this.fingerprint!, this.fingerprintComponents!, poswWorker);

    // Pending Event変更コールバックを設定（即時保存用）
    typingProof.setOnPendingEventChange(() => {
      this.saveToStorage();
    });

    // 共有された認証データがあれば event #0 として記録
    if (sharedAttestation) {
      await typingProof.recordHumanAttestation(sharedAttestation);
    }

    // モデルを作成
    const model = monaco.editor.createModel(content, language);

    const tab: TabState = {
      id,
      filename,
      language,
      typingProof,
      model,
      createdAt,
      verificationState: sharedAttestation ? 'verified' : 'skipped',
      verificationDetails: {
        timestamp: new Date().toISOString(),
      },
    };

    this.tabs.set(id, tab);
    this.tabOrder.push(id);

    // 最初のタブならアクティブに
    if (this.activeTabId === null) {
      await this.switchTab(id);
    }

    this.saveToStorage();
    return tab;
  }

  /**
   * タブを切り替え
   */
  async switchTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    const previousTabId = this.activeTabId;
    const previousTab = previousTabId ? this.tabs.get(previousTabId) ?? null : null;

    // タブ切り替えイベントを記録
    if (previousTabId !== tabId) {
      const switchEvent: TabSwitchEvent = {
        timestamp: performance.now() - this.startTime,
        fromTabId: previousTabId,
        toTabId: tabId,
        fromFilename: previousTab?.filename ?? null,
        toFilename: tab.filename
      };
      this.tabSwitches.push(switchEvent);
    }

    this.activeTabId = tabId;

    // エディタのモデルを切り替え
    this.editor.setModel(tab.model);

    // 言語を設定（モデル作成時に設定されているが、念のため）
    monaco.editor.setModelLanguage(tab.model, tab.language);

    // コールバックを呼び出し
    if (this.onTabChangeCallback) {
      this.onTabChangeCallback(tab, previousTab);
    }

    this.saveToStorage();
    return true;
  }

  /**
   * タブの名前を変更
   */
  renameTab(tabId: string, newFilename: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    tab.filename = newFilename;

    if (this.onTabUpdateCallback) {
      this.onTabUpdateCallback(tab);
    }

    this.saveToStorage();
    return true;
  }

  /**
   * タブの言語を変更
   */
  setTabLanguage(tabId: string, language: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    tab.language = language;
    monaco.editor.setModelLanguage(tab.model, language);

    if (this.onTabUpdateCallback) {
      this.onTabUpdateCallback(tab);
    }

    this.saveToStorage();
    return true;
  }


  /**
   * アクティブなタブを取得
   */
  getActiveTab(): TabState | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) ?? null;
  }

  /**
   * アクティブなタブのTypingProofを取得
   */
  getActiveProof(): TypingProof | null {
    const tab = this.getActiveTab();
    return tab?.typingProof ?? null;
  }

  /**
   * 全タブを取得（tabOrder順）
   */
  getAllTabs(): TabState[] {
    return this.tabOrder
      .map(id => this.tabs.get(id))
      .filter((tab): tab is TabState => tab !== undefined);
  }

  /**
   * タブIDでタブを取得
   */
  getTab(tabId: string): TabState | null {
    return this.tabs.get(tabId) ?? null;
  }

  /**
   * タブ切り替え履歴を取得
   */
  getTabSwitches(): TabSwitchEvent[] {
    return [...this.tabSwitches];
  }

  /**
   * タブの順序を変更
   * @param fromIndex 移動元インデックス
   * @param toIndex 移動先インデックス
   */
  reorderTab(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.tabOrder.length ||
        toIndex < 0 || toIndex >= this.tabOrder.length ||
        fromIndex === toIndex) {
      return false;
    }

    const [movedId] = this.tabOrder.splice(fromIndex, 1);
    if (!movedId) return false;

    this.tabOrder.splice(toIndex, 0, movedId);

    // コールバック通知
    const activeTab = this.getActiveTab();
    if (activeTab && this.onTabUpdateCallback) {
      this.onTabUpdateCallback(activeTab);
    }

    this.saveToStorage();
    return true;
  }

  /**
   * sessionStorageに同期的に保存（beforeunload用）
   *
   * beforeunloadではasync処理が完了しないため、
   * sessionStorageのみに同期的に保存する。
   * IndexedDBとの整合性はリロード時にsessionStorageを優先して復元することで保証。
   */
  saveToStorageSync(): void {
    console.log('[TabManager] saveToStorageSync called');

    // デバウンスタイマーがあればキャンセル
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    // sessionStorageに即座に保存
    this.saveToSessionStorage();

    // needsSaveをクリア（この保存で最新状態が保存された）
    this.needsSave = false;

    console.log('[TabManager] saveToStorageSync complete');
  }

  /**
   * ストレージに保存
   * - IndexedDB: 先に保存（完了を待機）
   * - sessionStorage: IndexedDB保存後に更新
   *
   * 重要:
   * 1. IndexedDBへの保存が完了してからsessionStorageを更新する（データ整合性保証）
   * 2. 高頻度呼び出し時はデバウンスして最新の状態のみを保存
   * 3. beforeunloadではsaveToStorageSync()を使用して同期的にsessionStorageに保存
   */
  saveToStorage(): void {
    // 次の保存が必要であることをマーク
    this.needsSave = true;

    // デバウンス：短時間に複数回呼ばれた場合は最後の呼び出しのみ実行
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;

      // 既に保存処理が実行中なら、完了後に再度保存される
      if (this.currentSavePromise) {
        return;
      }

      // 保存処理を開始
      this.executeSave();
    }, TabManager.SAVE_DEBOUNCE_MS);
  }

  /**
   * 実際の保存処理を実行
   * @private
   */
  private executeSave(): void {
    // needsSaveをクリアしてから保存開始
    // 保存中に新しいsaveToStorage()が呼ばれたらneedsSaveが再度trueになる
    this.needsSave = false;

    this.currentSavePromise = (async () => {
      try {
        // IndexedDBに先に保存
        await this.saveToIndexedDB();
        // IndexedDB保存完了後にsessionStorageを更新
        this.saveToSessionStorage();
      } catch (e) {
        console.error('[TabManager] Failed to save to IndexedDB:', e);
        // IndexedDBの保存に失敗しても、sessionStorageには保存する
        this.saveToSessionStorage();
      }
    })();

    this.currentSavePromise
      .finally(() => {
        this.currentSavePromise = null;

        // 保存中に新しい保存要求があった場合、最新状態で再保存
        if (this.needsSave) {
          this.executeSave();
        }
      });
  }

  /**
   * sessionStorageに軽量版を保存
   * @private
   */
  private saveToSessionStorage(): void {
    const sessionId = this.sessionService.getCurrentSessionId() ?? '';

    // V2フォーマット: 軽量版（eventsなし）
    const storage: LightweightMultiTabStorage = {
      version: 2,
      activeTabId: this.activeTabId ?? '',
      tabs: {},
      tabOrder: this.tabOrder,
      tabSwitches: this.tabSwitches,
      sessionId,
    };

    for (const [id, tab] of this.tabs) {
      const lightweightTab: LightweightTabState = {
        id,
        filename: tab.filename,
        language: tab.language,
        content: tab.model.getValue(),
        proofState: tab.typingProof.serializeLightweightState(),
        createdAt: tab.createdAt,
        verificationState: tab.verificationState,
        verificationDetails: tab.verificationDetails,
      };
      storage.tabs[id] = lightweightTab;
    }

    // sessionStorageに保存（リロード用、軽量版）
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[TabManager] sessionStorage quota exceeded - content may be too large');
      } else {
        console.error('[TabManager] Failed to save to sessionStorage:', e);
      }
    }
  }

  /**
   * IndexedDBに保存（永続化用）
   */
  private async saveToIndexedDB(): Promise<void> {
    if (!this.sessionService.isInitialized()) return;

    const sessionId = this.sessionService.getCurrentSessionId();
    if (!sessionId) return;

    // タブデータを保存
    for (const [id, tab] of this.tabs) {
      const proofState = tab.typingProof.serializeState();

      // 既存イベントの最大シーケンス番号を取得
      const existingEvents = await this.sessionService.getEvents(id);
      const maxExistingSequence = existingEvents.length > 0
        ? Math.max(...existingEvents.map(e => e.sequence))
        : -1;

      // 未保存のイベントをIndexedDBに追加（シーケンス番号が既存より大きいもののみ）
      for (const event of proofState.events) {
        if (event && event.sequence > maxExistingSequence) {
          await this.sessionService.appendEvent(id, event);
        }
      }

      const tabData: StoredTabData = {
        id,
        sessionId,
        filename: tab.filename,
        language: tab.language,
        content: tab.model.getValue(),
        createdAt: tab.createdAt,
        lastModifiedAt: Date.now(),
        lastWrittenEventIndex: proofState.events.length - 1,
        currentHash: proofState.currentHash,
        startTime: proofState.startTime,
        verificationState: tab.verificationState,
        verificationDetails: tab.verificationDetails,
        checkpoints: proofState.checkpoints,
      };
      await this.sessionService.saveTab(tabData);
    }

    // アクティブタブとタブ順序を更新
    if (this.activeTabId) {
      await this.sessionService.updateActiveTabId(this.activeTabId);
    }
    await this.sessionService.updateTabOrder(this.tabOrder);
  }

  /**
   * IndexedDBへの保存を完了させる（エクスポート前やbeforeunloadで呼び出す）
   *
   * 以下の処理を行う：
   * 1. デバウンスタイマーが動作中ならキャンセル
   * 2. 現在実行中の保存処理があれば完了を待機
   * 3. needsSaveがtrueなら（保存待ちの変更があれば）最新状態を保存
   * 4. 最新の状態を確実にIndexedDBに保存
   */
  async flushToIndexedDB(): Promise<void> {
    console.log('[TabManager] Flushing to IndexedDB...');

    // 1. デバウンスタイマーがあればキャンセル（即座に保存するため）
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    // 2. 現在実行中の保存処理があれば完了を待機
    if (this.currentSavePromise) {
      console.log('[TabManager] Waiting for current save to complete...');
      await this.currentSavePromise;
    }

    // 3. needsSaveがtrue（デバウンス中に変更があった）、または
    //    念のため最新状態を保存
    console.log('[TabManager] Saving latest state to IndexedDB...');
    await this.saveToIndexedDB();
    this.saveToSessionStorage();

    // needsSaveをクリア
    this.needsSave = false;

    console.log('[TabManager] IndexedDB flush complete');
  }

  /**
   * sessionStorageから読み込み
   * V1フォーマット: eventsあり（従来形式）
   * V2フォーマット: eventsなし（軽量版）→ IndexedDBからevents取得
   */
  async loadFromStorage(): Promise<boolean> {
    try {
      const data = sessionStorage.getItem(STORAGE_KEY);
      console.log('[DEBUG TabManager.loadFromStorage] STORAGE_KEY:', STORAGE_KEY);
      console.log('[DEBUG TabManager.loadFromStorage] data exists:', data !== null);
      console.log('[DEBUG TabManager.loadFromStorage] data length:', data?.length);
      if (!data) {
        // sessionStorageが空の場合、IndexedDBからのフォールバックを試みる
        console.log('[TabManager] sessionStorage is empty, trying IndexedDB fallback');
        const sessionId = this.sessionService.getCurrentSessionId();
        if (sessionId && this.fingerprint && this.fingerprintComponents) {
          console.log('[TabManager] Falling back to IndexedDB, sessionId:', sessionId);
          return await this.loadFromIndexedDB(sessionId, this.fingerprint, this.fingerprintComponents);
        }
        return false;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawStorage: any = JSON.parse(data);
      console.log('[DEBUG TabManager.loadFromStorage] rawStorage.version:', rawStorage.version);
      console.log('[DEBUG TabManager.loadFromStorage] tabs count:', Object.keys(rawStorage.tabs ?? {}).length);

      // バージョン別に処理を分岐
      if (rawStorage.version === 1) {
        // V1: 従来形式（eventsあり）→ そのまま読み込み、次回保存でV2に移行
        console.log('[TabManager] Loading V1 format (will migrate to V2 on next save)');
        return await this.loadFromStorageV1(rawStorage);
      } else if (rawStorage.version === 2) {
        // V2: 軽量形式（eventsなし）→ IndexedDBからevents取得
        console.log('[TabManager] Loading V2 format (lightweight)');
        return await this.loadFromStorageV2(rawStorage);
      } else {
        console.warn(`[TabManager] Unknown storage version: ${rawStorage.version}`);
        sessionStorage.removeItem(STORAGE_KEY);
        return false;
      }
    } catch (e) {
      console.error('[TabManager] Failed to load from storage:', e);
      console.error('[DEBUG TabManager.loadFromStorage] Error details:', e);
      return false;
    }
  }

  /**
   * V1フォーマット（従来形式）からの読み込み
   * eventsがsessionStorageに含まれている
   * @private
   */
  private async loadFromStorageV1(rawStorage: MultiTabStorage): Promise<boolean> {
    // tabOrderがない場合は生成（後方互換性のため）
    const tabOrder: string[] = rawStorage.tabOrder ?? Object.keys(rawStorage.tabs);

    // Pending Eventsの処理を追跡
    let totalPendingEvents = 0;
    let processedPendingEvents = 0;

    // タブを復元（tabOrder順に処理）
    for (const id of tabOrder) {
      const serializedTab = rawStorage.tabs[id];
      if (!serializedTab) continue;

      let typingProof: TypingProof;

      // Workerをeditorパッケージから作成
      const poswWorker = createPoswWorker();

      if (serializedTab.proofState) {
        const pendingCount = serializedTab.proofState.pendingEvents?.length ?? 0;
        totalPendingEvents += pendingCount;

        if (pendingCount > 0) {
          console.log(`[TabManager] Tab ${id} has ${pendingCount} pending events to process`);
        }

        typingProof = await TypingProof.fromSerializedState(
          serializedTab.proofState,
          this.fingerprint!,
          this.fingerprintComponents!,
          poswWorker,
          true // processPending = true
        );

        // 処理されたPending Eventsをカウント
        processedPendingEvents += pendingCount - typingProof.getPendingEvents().length;
      } else {
        typingProof = new TypingProof();
        await typingProof.initialize(this.fingerprint!, this.fingerprintComponents!, poswWorker);
      }

      // Pending Event変更コールバックを設定（即時保存用）
      typingProof.setOnPendingEventChange(() => {
        this.saveToStorage();
      });

      const model = monaco.editor.createModel(serializedTab.content, serializedTab.language);

      const tab: TabState = {
        id,
        filename: serializedTab.filename,
        language: serializedTab.language,
        typingProof,
        model,
        createdAt: serializedTab.createdAt,
        verificationState: serializedTab.verificationState ?? 'skipped',
        verificationDetails: serializedTab.verificationDetails,
      };

      this.tabs.set(id, tab);
      this.tabOrder.push(id);
    }

    // タブ切り替え履歴を復元
    this.tabSwitches = rawStorage.tabSwitches ?? [];

    // アクティブタブを復元
    if (rawStorage.activeTabId && this.tabs.has(rawStorage.activeTabId)) {
      await this.switchTab(rawStorage.activeTabId);
    } else if (this.tabs.size > 0) {
      const firstTabId = Array.from(this.tabs.keys())[0]!;
      await this.switchTab(firstTabId);
    }

    console.log('[DEBUG TabManager.loadFromStorageV1] SUCCESS - tabs restored:', this.tabs.size);
    console.log('[DEBUG TabManager.loadFromStorageV1] activeTabId:', this.activeTabId);

    if (totalPendingEvents > 0) {
      console.log(`[TabManager] Processed ${processedPendingEvents}/${totalPendingEvents} pending events during restore`);
    }

    console.log('[TabManager] V1 format loaded, will migrate to V2 on next save');
    return true;
  }

  /**
   * V2フォーマット（軽量版）からの読み込み
   * eventsはIndexedDBから取得
   * @private
   */
  private async loadFromStorageV2(storage: LightweightMultiTabStorage): Promise<boolean> {
    // Pending Eventsの処理を追跡
    let totalPendingEvents = 0;
    let processedPendingEvents = 0;

    // タブを復元（tabOrder順に処理）
    for (const id of storage.tabOrder) {
      const lightweightTab = storage.tabs[id];
      if (!lightweightTab) continue;

      // 1. IndexedDBからイベントを読み込み
      const events = await this.sessionService.getEvents(id);

      // 2. 同期確認と currentHash の決定
      // IMPORTANT: sessionStorageのcurrentHashではなく、IndexedDBから取得したイベントの
      // 最後のhashを使用する。これにより、IndexedDBへの保存が遅延した場合でも
      // 整合性が保たれる。
      const expectedSequence = lightweightTab.proofState.lastEventSequence;
      const actualSequence = events.length - 1;
      const lastEvent = events[events.length - 1];

      // IndexedDBの最後のイベントのhashをcurrentHashとして使用
      // sessionStorageのcurrentHashは信頼できない（非同期保存の遅延により不一致の可能性）
      const currentHash = lastEvent?.hash ?? null;

      if (actualSequence < expectedSequence) {
        console.warn(`[TabManager] Event sync mismatch for tab ${id}: expected seq ${expectedSequence}, got ${actualSequence}. Using IndexedDB hash as currentHash.`);
        // 一部イベントが未保存の可能性があるが、IndexedDBのデータを正とする
      }

      // 3. SerializedProofStateを構築
      const proofState: SerializedProofState = {
        events,
        currentHash,  // IndexedDBから取得したイベントの最後のhashを使用
        startTime: lightweightTab.proofState.startTime,
        pendingEvents: lightweightTab.proofState.pendingEvents ?? [],
        checkpoints: lightweightTab.proofState.checkpoints,
      };

      const pendingCount = proofState.pendingEvents?.length ?? 0;
      totalPendingEvents += pendingCount;

      if (pendingCount > 0) {
        console.log(`[TabManager] Tab ${id} has ${pendingCount} pending events to process`);
      }

      // 4. TypingProofを復元
      const poswWorker = createPoswWorker();
      const typingProof = await TypingProof.fromSerializedState(
        proofState,
        this.fingerprint!,
        this.fingerprintComponents!,
        poswWorker,
        true // processPending = true
      );

      // 処理されたPending Eventsをカウント
      processedPendingEvents += pendingCount - typingProof.getPendingEvents().length;

      // 5. コールバック設定
      typingProof.setOnPendingEventChange(() => {
        this.saveToStorage();
      });

      // 6. Monacoモデル作成（contentはsessionStorageから）
      const model = monaco.editor.createModel(
        lightweightTab.content,
        lightweightTab.language
      );

      // 7. タブ作成
      const tab: TabState = {
        id,
        filename: lightweightTab.filename,
        language: lightweightTab.language,
        typingProof,
        model,
        createdAt: lightweightTab.createdAt,
        verificationState: lightweightTab.verificationState ?? 'skipped',
        verificationDetails: lightweightTab.verificationDetails,
      };

      this.tabs.set(id, tab);
      this.tabOrder.push(id);
    }

    // タブ切り替え履歴を復元
    this.tabSwitches = storage.tabSwitches ?? [];

    // アクティブタブを復元
    if (storage.activeTabId && this.tabs.has(storage.activeTabId)) {
      await this.switchTab(storage.activeTabId);
    } else if (this.tabs.size > 0) {
      const firstTabId = Array.from(this.tabs.keys())[0]!;
      await this.switchTab(firstTabId);
    }

    console.log('[DEBUG TabManager.loadFromStorageV2] SUCCESS - tabs restored:', this.tabs.size);
    console.log('[DEBUG TabManager.loadFromStorageV2] activeTabId:', this.activeTabId);

    if (totalPendingEvents > 0) {
      console.log(`[TabManager] Processed ${processedPendingEvents}/${totalPendingEvents} pending events during restore`);
    }

    return true;
  }

  /**
   * IndexedDBからセッションを復旧
   * ブラウザタブを閉じた後の復旧に使用
   */
  async loadFromIndexedDB(
    sessionId: string,
    fingerprintHash?: string,
    fingerprintComponents?: FingerprintComponents
  ): Promise<boolean> {
    try {
      console.log('[TabManager] Loading from IndexedDB, sessionId:', sessionId);

      // fingerprint が引数として渡された場合は設定
      if (fingerprintHash && fingerprintComponents) {
        this.fingerprint = fingerprintHash;
        this.fingerprintComponents = fingerprintComponents;
      }

      // fingerprint が未設定の場合はエラー
      if (!this.fingerprint || !this.fingerprintComponents) {
        console.error('[TabManager] Fingerprint not set');
        return false;
      }

      // セッションを再開
      await this.sessionService.resumeSession(sessionId);

      // タブデータを読み込み
      const storedTabs = await this.sessionService.loadTabs(sessionId);
      console.log('[TabManager] Found tabs in IndexedDB:', storedTabs.length);

      if (storedTabs.length === 0) {
        return false;
      }

      // セッションメタデータからタブ順序を取得
      const session = await this.sessionService.getLatestSession();
      const tabOrder = session?.tabOrder ?? storedTabs.map(t => t.id);
      const activeTabId = session?.activeTabId ?? storedTabs[0]?.id;

      // タブを復元（tabOrder順に処理）
      for (const tabId of tabOrder) {
        const storedTab = storedTabs.find(t => t.id === tabId);
        if (!storedTab) continue;

        // イベントを読み込み
        const events = await this.sessionService.getEvents(tabId);
        console.log(`[TabManager] Tab ${tabId}: ${events.length} events loaded`);

        // TypingProofを復元
        const poswWorker = createPoswWorker();
        const typingProof = await TypingProof.fromSerializedState(
          {
            events,
            currentHash: storedTab.currentHash,
            startTime: storedTab.startTime,
            pendingEvents: [], // IndexedDB復元時はpendingEventsなし
            checkpoints: storedTab.checkpoints,
          },
          this.fingerprint,
          this.fingerprintComponents,
          poswWorker
        );

        // Pending Event変更コールバックを設定（即時保存用）
        typingProof.setOnPendingEventChange(() => {
          this.saveToStorage();
        });

        // Monacoモデルを作成
        const model = monaco.editor.createModel(storedTab.content, storedTab.language);

        const tab: TabState = {
          id: storedTab.id,
          filename: storedTab.filename,
          language: storedTab.language,
          typingProof,
          model,
          createdAt: storedTab.createdAt,
          verificationState: storedTab.verificationState,
          verificationDetails: storedTab.verificationDetails,
        };

        this.tabs.set(storedTab.id, tab);
        this.tabOrder.push(storedTab.id);
      }

      // タブ切り替え履歴を復元
      this.tabSwitches = await this.sessionService.getTabSwitches(sessionId);

      // アクティブタブを復元
      if (activeTabId && this.tabs.has(activeTabId)) {
        await this.switchTab(activeTabId);
      } else if (this.tabs.size > 0) {
        const firstTabId = Array.from(this.tabs.keys())[0]!;
        await this.switchTab(firstTabId);
      }

      console.log('[TabManager] Session restored from IndexedDB, tabs:', this.tabs.size);
      return true;
    } catch (e) {
      console.error('[TabManager] Failed to load from IndexedDB:', e);
      return false;
    }
  }

  /**
   * SessionStorageServiceを取得
   */
  getSessionService(): SessionStorageService {
    return this.sessionService;
  }

  /**
   * 全データをリセット
   * @returns リセット成功時はtrue、reCAPTCHA失敗時はfalse
   */
  async reset(): Promise<boolean> {
    // 全モデルを破棄
    for (const tab of this.tabs.values()) {
      tab.model.dispose();
    }

    // データをクリア
    this.tabs.clear();
    this.tabOrder = [];
    this.activeTabId = null;
    this.tabSwitches = [];
    this.startTime = performance.now();

    // ストレージをクリア（sessionStorage + IndexedDB）
    sessionStorage.removeItem(STORAGE_KEY);
    try {
      await this.sessionService.clearSession();
    } catch (e) {
      console.error('[TabManager] Failed to clear IndexedDB session:', e);
    }

    // 新しいタブを作成
    const tab = await this.createTab('Untitled-1', 'c', '// Hello, TypedCode!\n');
    if (!tab) {
      console.error('[TabManager] Failed to create tab after reset (reCAPTCHA failed)');
      return false;
    }

    return true;
  }

  /**
   * 単一タブをエクスポート（既存形式）
   */
  async exportSingleTab(tabId: string): Promise<ExportedProof | null> {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;

    const content = tab.model.getValue();
    return await tab.typingProof.exportProof(content);
  }

  /**
   * 全タブをエクスポート（マルチファイル形式）
   */
  async exportAllTabs(): Promise<MultiFileExportedProof> {
    const files: Record<string, MultiFileExportEntry> = {};
    let overallPureTyping = true;

    for (const tab of this.tabs.values()) {
      const content = tab.model.getValue();
      const proof = await tab.typingProof.exportProof(content);

      // ファイル名に拡張子を追加（まだない場合）
      let filename = tab.filename;
      const ext = '.' + getFileExtension(tab.language);
      if (!filename.endsWith(ext)) {
        filename = filename + ext;
      }

      // 重複ファイル名を処理
      let uniqueFilename = filename;
      let counter = 1;
      while (files[uniqueFilename]) {
        const baseName = filename.replace(/\.[^.]+$/, '');
        const extension = filename.match(/\.[^.]+$/)?.[0] ?? '';
        uniqueFilename = `${baseName}_${counter}${extension}`;
        counter++;
      }

      files[uniqueFilename] = {
        content,
        language: tab.language,
        typingProofHash: proof.typingProofHash,
        typingProofData: proof.typingProofData,
        proof: proof.proof
      };

      if (!proof.metadata.isPureTyping) {
        overallPureTyping = false;
      }
    }

    return {
      version: PROOF_FORMAT_VERSION,
      type: 'multi-file',
      fingerprint: {
        hash: this.fingerprint!,
        components: this.fingerprintComponents!
      },
      files,
      tabSwitches: this.tabSwitches,
      metadata: {
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        totalFiles: Object.keys(files).length,
        overallPureTyping
      }
    };
  }

  /**
   * アクティブタブの内容を取得
   */
  getActiveContent(): string {
    const tab = this.getActiveTab();
    return tab?.model.getValue() ?? '';
  }

  /**
   * タブ数を取得
   */
  getTabCount(): number {
    return this.tabs.size;
  }
}
