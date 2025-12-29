/**
 * TabManager - マルチタブ管理システム
 * 複数のタブとそれぞれのハッシュチェーンを管理
 */

import * as monaco from 'monaco-editor';
import { TypingProof } from '@typedcode/shared';
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
  performTurnstileVerification,
  type VerificationResult,
} from '../../services/TurnstileService.js';

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
  /** localStorageからの復元時はtrue（reCAPTCHA不要） */
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
    const loaded = await this.loadFromStorage();

    // タブがない場合は新規タブを作成
    console.log('[DEBUG TabManager] loaded:', loaded, 'tabs.size:', this.tabs.size);
    if (!loaded || this.tabs.size === 0) {
      console.log('[DEBUG TabManager] Creating initial tab...');
      const tab = await this.createTab('Untitled-1', 'c', '// Hello, TypedCode!\n');
      console.log('[DEBUG TabManager] createTab result:', tab);
      if (!tab) {
        console.error('[TabManager] Failed to create initial tab (verification failed)');
        return false;
      }
    }

    console.log('[DEBUG TabManager] initialize() returning true');
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

      // ローディングモーダルを表示
      const loadingModal = document.getElementById('verification-loading-modal');
      const statusText = document.getElementById('verification-status-text');
      const progressBar = document.getElementById('verification-timeout-progress');
      loadingModal?.classList.remove('hidden');
      if (statusText) statusText.textContent = '接続中...';

      // 20秒のプログレスバーアニメーション
      const TIMEOUT_MS = 20000;
      const startTime = Date.now();
      let animationFrame: number | null = null;

      const updateProgress = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / TIMEOUT_MS) * 100, 100);
        if (progressBar) {
          progressBar.style.width = `${progress}%`;
        }
        if (elapsed < TIMEOUT_MS) {
          animationFrame = requestAnimationFrame(updateProgress);
        }
      };
      animationFrame = requestAnimationFrame(updateProgress);

      let result: VerificationResult;
      try {
        // 認証実行（TurnstileService内で20秒タイムアウト）
        result = await performTurnstileVerification('create_tab');
      } catch (error) {
        // エラー時（ネットワークエラー等）はタイムアウトとして扱う
        console.error('[TabManager] Verification error:', error);
        result = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          failureReason: 'network_error',
        };
      } finally {
        // アニメーション停止
        if (animationFrame !== null) {
          cancelAnimationFrame(animationFrame);
        }
        // プログレスバーをリセット
        if (progressBar) {
          progressBar.style.width = '0%';
        }
        // ローディングモーダルを非表示
        loadingModal?.classList.add('hidden');
      }

      // 認証状態を設定
      verificationState = result.success ? 'verified' : 'failed';
      verificationDetails = {
        timestamp: new Date().toISOString(),
        failureReason: result.failureReason,
      };

      // 認証結果をハッシュチェーンに記録（成功・失敗問わず）
      const attestationData: HumanAttestationEventData = {
        verified: result.attestation?.verified ?? false,
        score: result.attestation?.score ?? 0,
        action: result.attestation?.action ?? 'create_tab',
        timestamp: result.attestation?.timestamp ?? new Date().toISOString(),
        hostname: result.attestation?.hostname ?? window.location.hostname,
        signature: result.attestation?.signature ?? 'unsigned',
        success: result.success,
        failureReason: result.failureReason,
      };

      await typingProof.recordHumanAttestation(attestationData);

      // コールバックで通知
      this.onVerificationCallback?.(result);

      console.log('[TabManager] Human attestation recorded:',
        result.success ? 'verified' : `failed (${result.failureReason ?? result.error})`);

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

    // 最後のタブは閉じない
    if (this.tabs.size <= 1) {
      console.warn('[TabManager] Cannot close the last tab');
      return false;
    }

    // モデルを破棄
    tab.model.dispose();

    // タブを削除
    this.tabs.delete(tabId);

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
   * 全タブを取得
   */
  getAllTabs(): TabState[] {
    return Array.from(this.tabs.values());
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
   * localStorageに保存
   */
  saveToStorage(): void {
    const storage: MultiTabStorage = {
      version: 2,
      activeTabId: this.activeTabId ?? '',
      tabs: {},
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (e) {
      console.error('[TabManager] Failed to save to storage:', e);
    }
  }

  /**
   * localStorageから読み込み
   */
  async loadFromStorage(): Promise<boolean> {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return false;

      const storage: MultiTabStorage = JSON.parse(data);

      // バージョンチェック
      if (storage.version !== 2) {
        console.warn('[TabManager] Storage version mismatch, clearing data');
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }

      // タブを復元
      for (const [id, serializedTab] of Object.entries(storage.tabs)) {
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

      return true;
    } catch (e) {
      console.error('[TabManager] Failed to load from storage:', e);
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
    this.activeTabId = null;
    this.tabSwitches = [];
    this.startTime = performance.now();

    // ストレージをクリア
    localStorage.removeItem(STORAGE_KEY);

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
      version: '3.1.0',
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
