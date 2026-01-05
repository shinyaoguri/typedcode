/**
 * TabManager - マルチタブ管理システム
 * 複数のタブとそれぞれのハッシュチェーンを管理
 */

import * as monaco from 'monaco-editor';
import { TypingProof, PROOF_FORMAT_VERSION, STORAGE_FORMAT_VERSION } from '@typedcode/shared';
import type {
  FingerprintComponents,
  TabSwitchEvent,
  SerializedTabState,
  MultiTabStorage,
  ExportedProof,
  MultiFileExportedProof,
  MultiFileExportEntry,
  HumanAttestationEventData,
  VerificationState,
  VerificationDetails,
} from '@typedcode/shared';
import {
  isTurnstileConfigured,
  type VerificationResult,
} from '../../services/TurnstileService.js';
import { performVerificationWithUI } from './TabVerificationUI.js';
import { t } from '../../i18n/index.js';

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

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
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
   * sessionStorageに保存
   * sessionStorageを使用することで、各ブラウザタブが独立したセッションとして動作する
   * - リロード時: データは保持される
   * - 新規タブ: 空の状態から開始（VSCode.devと同様の動作）
   */
  saveToStorage(): void {
    const storage: MultiTabStorage = {
      version: STORAGE_FORMAT_VERSION,
      activeTabId: this.activeTabId ?? '',
      tabs: {},
      tabOrder: this.tabOrder,
      tabSwitches: this.tabSwitches
    };

    for (const [id, tab] of this.tabs) {
      const serializedTab: SerializedTabState = {
        id,
        filename: tab.filename,
        language: tab.language,
        content: tab.model.getValue(),
        proofState: tab.typingProof.serializeState(),
        createdAt: tab.createdAt,
        verificationState: tab.verificationState,
        verificationDetails: tab.verificationDetails,
      };
      storage.tabs[id] = serializedTab;
    }

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (e) {
      console.error('[TabManager] Failed to save to storage:', e);
    }
  }

  /**
   * sessionStorageから読み込み
   */
  async loadFromStorage(): Promise<boolean> {
    try {
      const data = sessionStorage.getItem(STORAGE_KEY);
      console.log('[DEBUG TabManager.loadFromStorage] STORAGE_KEY:', STORAGE_KEY);
      console.log('[DEBUG TabManager.loadFromStorage] data exists:', data !== null);
      console.log('[DEBUG TabManager.loadFromStorage] data length:', data?.length);
      if (!data) return false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawStorage: any = JSON.parse(data);
      console.log('[DEBUG TabManager.loadFromStorage] rawStorage.version:', rawStorage.version);
      console.log('[DEBUG TabManager.loadFromStorage] tabs count:', Object.keys(rawStorage.tabs ?? {}).length);

      // バージョンチェックとマイグレーション
      // STORAGE_FORMAT_VERSION (現在は1) を使用して互換性を確認
      if (rawStorage.version !== STORAGE_FORMAT_VERSION) {
        console.warn(`[TabManager] Storage version mismatch: expected ${STORAGE_FORMAT_VERSION}, got ${rawStorage.version}`);
        sessionStorage.removeItem(STORAGE_KEY);
        return false;
      }

      // tabOrderがない場合は生成（後方互換性のため）
      const tabOrder: string[] = rawStorage.tabOrder ?? Object.keys(rawStorage.tabs);

      // タブを復元（tabOrder順に処理）
      for (const id of tabOrder) {
        const serializedTab = rawStorage.tabs[id];
        if (!serializedTab) continue;

        let typingProof: TypingProof;

        // Workerをeditorパッケージから作成
        const poswWorker = createPoswWorker();

        if (serializedTab.proofState) {
          typingProof = await TypingProof.fromSerializedState(
            serializedTab.proofState,
            this.fingerprint!,
            this.fingerprintComponents!,
            poswWorker
          );
        } else {
          typingProof = new TypingProof();
          await typingProof.initialize(this.fingerprint!, this.fingerprintComponents!, poswWorker);
        }

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

      console.log('[DEBUG TabManager.loadFromStorage] SUCCESS - tabs restored:', this.tabs.size);
      console.log('[DEBUG TabManager.loadFromStorage] activeTabId:', this.activeTabId);
      return true;
    } catch (e) {
      console.error('[TabManager] Failed to load from storage:', e);
      console.error('[DEBUG TabManager.loadFromStorage] Error details:', e);
      return false;
    }
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

    // ストレージをクリア
    sessionStorage.removeItem(STORAGE_KEY);

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
