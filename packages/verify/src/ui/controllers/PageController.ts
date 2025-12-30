/**
 * PageController - ページ全体のオーケストレーション
 *
 * ファイル処理、タブ管理、検証キュー、結果表示を統括するコントローラー。
 * main.ts から抽出。
 */

import JSZip from 'jszip';
import type { ProofFile, VerifyTabState, VerificationResultData } from '../../types.js';
import {
  showDropZoneLoading,
  addLoadingLog,
  updateLoadingLog,
  resetDropZoneLoading,
  hideDropZone,
  showError,
} from '../../ui.js';
import { initializeSeekbarListeners, getCurrentEventIndex } from '../../seekbar.js';
import { verifyProofData } from '../../verification.js';
import { redrawMouseTrajectory } from '../../charts.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import { VerificationQueue } from '../../state/VerificationQueue.js';
import { VerifyFileListController } from '../VerifyFileListController.js';
import { VerifyStatusBar } from '../StatusBar.js';

// ============================================================================
// 型定義
// ============================================================================

/** PageController の設定 */
export interface PageControllerOptions {
  /** ドロップゾーン要素 */
  dropZone: HTMLElement | null;
  /** ファイル入力要素 */
  fileInput: HTMLInputElement | null;
  /** 追加ファイル入力要素（結果画面内） */
  fileInput2?: HTMLInputElement | null;
  /** ドロップゾーンセクション */
  dropZoneSection: HTMLElement | null;
  /** メインコンテンツ */
  verifyMain: HTMLElement | null;
  /** ファイルリスト */
  verifyFileList: HTMLElement | null;
  /** サイドバー */
  verifySidebar: HTMLElement | null;
  /** リサイズハンドル */
  resizeHandle: HTMLElement | null;
  /** ステータスバー */
  verifyStatusbar: HTMLElement | null;
  /** タブコンテンツローディング */
  tabContentLoading: HTMLElement | null;
  /** 結果セクション */
  resultSection: HTMLElement | null;
  /** タイムラインタブ */
  tabTimeline: HTMLElement | null;
  /** マウスタブ */
  tabMouse: HTMLElement | null;
  /** タイムラインパネル */
  panelTimeline: HTMLElement | null;
  /** マウスパネル */
  panelMouse: HTMLElement | null;
}

// ============================================================================
// PageController クラス
// ============================================================================

/**
 * ページ全体のオーケストレーションコントローラー
 */
export class PageController {
  private options: PageControllerOptions;

  // 状態管理
  private tabManager: VerifyTabManager | null = null;
  private verificationQueue: VerificationQueue | null = null;
  private fileListController: VerifyFileListController | null = null;
  private statusBar: VerifyStatusBar | null = null;

  // 現在のレンダリングセッションID（タブ切り替え時にキャンセルするため）
  private currentRenderSessionId: string | null = null;

  // 現在表示中のタブID
  private currentDisplayedTabId: string | null = null;

  constructor(options: PageControllerOptions) {
    this.options = options;
  }

  /**
   * コントローラーを初期化
   */
  initialize(): void {
    this.setupDropZone();
    this.setupFileInputs();
    this.setupTabSwitching();
    initializeSeekbarListeners();
  }

  /**
   * ドロップゾーンのイベントを設定
   */
  private setupDropZone(): void {
    const { dropZone } = this.options;
    if (!dropZone) return;

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        void this.handleFile(files[0]!);
      }
    });
  }

  /**
   * ファイル入力のイベントを設定
   */
  private setupFileInputs(): void {
    const { fileInput, fileInput2 } = this.options;

    fileInput?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files.length > 0) {
        void this.handleFile(target.files[0]!);
      }
    });

    fileInput2?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files.length > 0) {
        void this.handleFile(target.files[0]!);
      }
    });
  }

  /**
   * タブ切り替えのイベントを設定
   */
  private setupTabSwitching(): void {
    const { tabTimeline, tabMouse } = this.options;

    tabTimeline?.addEventListener('click', () => this.switchTab('timeline'));
    tabMouse?.addEventListener('click', () => this.switchTab('mouse'));
  }

  /**
   * タブを切り替え
   */
  private switchTab(tab: 'timeline' | 'mouse'): void {
    const { tabTimeline, tabMouse, panelTimeline, panelMouse } = this.options;

    if (tab === 'timeline') {
      tabTimeline?.classList.add('active');
      tabMouse?.classList.remove('active');
      panelTimeline?.classList.add('active');
      panelMouse?.classList.remove('active');
    } else {
      tabTimeline?.classList.remove('active');
      tabMouse?.classList.add('active');
      panelTimeline?.classList.remove('active');
      panelMouse?.classList.add('active');

      // マウス軌跡パネルが表示されたらキャンバスを再描画
      requestAnimationFrame(() => {
        redrawMouseTrajectory(getCurrentEventIndex());
      });
    }
  }

  /**
   * マルチファイルモードを初期化
   */
  private initializeMultiFileMode(): void {
    if (this.tabManager) return; // 既に初期化済み

    this.tabManager = new VerifyTabManager();
    this.verificationQueue = new VerificationQueue();

    const { verifyFileList, verifySidebar, resizeHandle, verifyStatusbar } = this.options;

    if (verifyFileList && verifySidebar && resizeHandle) {
      this.fileListController = new VerifyFileListController({
        listContainer: verifyFileList,
        sidebarContainer: verifySidebar,
        resizeHandle,
        tabManager: this.tabManager,
      });
    }

    if (verifyStatusbar) {
      this.statusBar = new VerifyStatusBar(verifyStatusbar);
    }

    // タブ変更時のハンドラ
    this.tabManager.setOnChange((tab, _prevTab) => {
      this.fileListController?.updateActiveItem();
      this.showTabContent(tab);
    });

    // タブ更新時のハンドラ
    this.tabManager.setOnUpdate((tab) => {
      this.fileListController?.updateItemStatus(tab.id, tab.status, tab.progress, tab.progressDetails);
      this.updateStatusBar();
    });

    // 検証進捗ハンドラ
    this.verificationQueue.setOnProgress(({ id, progress, details }) => {
      if (this.tabManager) {
        this.tabManager.updateTab(id, {
          progress,
          progressPhase: details.phase,
          progressDetails: details,
          status: 'verifying',
        });
      }
      this.updateStatusBar();
    });

    // 検証完了ハンドラ
    this.verificationQueue.setOnComplete((id, result) => {
      this.handleVerificationComplete(id, result);
    });

    // 検証エラーハンドラ
    this.verificationQueue.setOnError((id, error) => {
      if (this.tabManager) {
        this.tabManager.updateTab(id, {
          status: 'error',
          error,
          progress: 100,
        });
      }
      this.updateStatusBar();
    });

    // Workerを初期化
    this.verificationQueue.initialize();
  }

  /**
   * 検証完了時の処理
   */
  private handleVerificationComplete(id: string, result: VerificationResultData): void {
    if (!this.tabManager || !this.verificationQueue) return;

    const proofData = this.verificationQueue.getParsedData(id);

    // ステータスを決定
    let status: VerifyTabState['status'] = 'success';
    if (!result.metadataValid || !result.chainValid) {
      status = 'error';
    } else if (!result.isPureTyping) {
      status = 'warning';
    }

    this.tabManager.updateTab(id, {
      status,
      progress: 100,
      verificationResult: result,
      proofData,
    });

    // アクティブタブなら結果を表示
    const activeTab = this.tabManager.getActiveTab();
    if (activeTab && activeTab.id === id) {
      this.showTabContent(activeTab);
    }

    this.updateStatusBar();
  }

  /**
   * タブの内容を表示
   */
  private showTabContent(tab: VerifyTabState): void {
    const { tabContentLoading, resultSection } = this.options;
    if (!tabContentLoading || !resultSection) return;

    // 現在のレンダリングをキャンセル（新しいセッションIDを生成）
    this.currentRenderSessionId = crypto.randomUUID();
    const sessionId = this.currentRenderSessionId;

    if (tab.status === 'pending' || tab.status === 'verifying') {
      // 検証中はローディング表示
      tabContentLoading.style.display = 'flex';
      resultSection.style.display = 'none';
      this.currentDisplayedTabId = null;
    } else if (tab.proofData && tab.verificationResult) {
      // 検証完了したら結果を表示
      tabContentLoading.style.display = 'none';
      resultSection.style.display = 'flex';

      // 同じタブなら何もしない
      if (this.currentDisplayedTabId === tab.id) {
        return;
      }

      // 新規レンダリング
      this.currentDisplayedTabId = tab.id;
      void this.renderVerificationResult(tab, sessionId);
    } else if (tab.status === 'error') {
      // エラーの場合
      tabContentLoading.style.display = 'none';
      resultSection.style.display = 'flex';
      this.currentDisplayedTabId = null;
      showError('検証に失敗しました', tab.error ?? '不明なエラー');
    }
  }

  /**
   * 検証結果をレンダリング
   */
  private async renderVerificationResult(tab: VerifyTabState, _sessionId: string): Promise<void> {
    if (!tab.proofData) return;

    // Workerで検証済みの結果を渡して、再検証をスキップ
    const preVerified = tab.verificationResult ? {
      metadataValid: tab.verificationResult.metadataValid,
      chainValid: tab.verificationResult.chainValid,
      isPureTyping: tab.verificationResult.isPureTyping,
      poswStats: tab.verificationResult.poswStats,
      sampledResult: tab.verificationResult.sampledResult,
    } : undefined;

    await verifyProofData(tab.proofData, preVerified);
  }

  /**
   * ステータスバーを更新
   */
  private updateStatusBar(): void {
    if (!this.statusBar || !this.verificationQueue || !this.tabManager) return;

    const pendingCount = this.verificationQueue.getQueueLength();
    const processing = this.verificationQueue.getCurrentProcessing();

    if (processing) {
      const tab = this.tabManager.getTab(processing.id);
      this.statusBar.update({
        pendingCount,
        currentFile: processing.filename,
        currentProgress: tab?.progress ?? 0,
        progressDetails: tab?.progressDetails,
      });
    } else {
      // 全件完了
      const allTabs = this.tabManager.getAllTabs();
      const successCount = allTabs.filter(t => t.status === 'success' || t.status === 'warning').length;
      const errorCount = allTabs.filter(t => t.status === 'error').length;

      if (allTabs.length > 0 && pendingCount === 0) {
        this.statusBar.showComplete(allTabs.length, successCount, errorCount);
      } else {
        this.statusBar.update({
          pendingCount,
          currentFile: null,
          currentProgress: 0,
        });
      }
    }
  }

  /**
   * ファイル処理のメインエントリポイント
   */
  async handleFile(file: File): Promise<void> {
    if (file.name.endsWith('.zip')) {
      await this.handleZipFile(file);
    } else if (file.name.endsWith('.json')) {
      // 既にマルチファイルモードなら追加、そうでなければ従来モード
      if (this.tabManager) {
        await this.handleJsonFileMultiMode(file);
      } else {
        await this.handleSingleJsonFile(file);
      }
    } else {
      showError('対応していないファイル形式', '.json または .zip ファイルを選択してください');
    }
  }

  /**
   * 単体JSONファイルを処理（従来の動作）
   */
  private async handleSingleJsonFile(file: File): Promise<void> {
    // 即座にローディング状態を表示
    showDropZoneLoading(file.name);

    // ファイル読み込みログ
    const readLog = addLoadingLog('ファイルを読み込み中...');

    try {
      const text = await file.text();
      const fileSize = (text.length / 1024).toFixed(1);
      updateLoadingLog(readLog, 'success', `ファイル読み込み完了 (${fileSize} KB)`);

      // JSON解析ログ
      const parseLog = addLoadingLog('JSONを解析中...');
      const proofData = JSON.parse(text) as ProofFile;
      const eventCount = proofData.proof?.events?.length ?? 0;
      updateLoadingLog(parseLog, 'success', `JSON解析完了 (${eventCount} イベント)`);

      await verifyProofData(proofData);
      // 検証完了後、ドロップゾーンを非表示
      hideDropZone();
    } catch (error) {
      console.error('[Verify] Error reading file:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLoadingLog(`エラー: ${errorMessage}`, 'error');
      showError('ファイルの読み込みに失敗しました', errorMessage);
      // エラー時はドロップゾーンを復元
      setTimeout(() => resetDropZoneLoading((f) => this.handleFile(f)), 2000);
    }
  }

  /**
   * ZIPファイルを処理
   */
  private async handleZipFile(file: File): Promise<void> {
    // マルチファイルモードを初期化
    this.initializeMultiFileMode();

    showDropZoneLoading(file.name);
    const readLog = addLoadingLog('ZIPファイルを読み込み中...');

    try {
      const arrayBuffer = await file.arrayBuffer();
      updateLoadingLog(readLog, 'success', `ZIP読み込み完了 (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`);

      const extractLog = addLoadingLog('ZIPを展開中...');
      const zip = await JSZip.loadAsync(arrayBuffer);

      // TC_*.json ファイルを抽出
      const proofFiles: { name: string; content: string; language: string }[] = [];

      for (const [path, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;

        // TC_*.json パターンにマッチするか確認
        const filename = path.split('/').pop() ?? path;
        if (filename.match(/^TC_.*\.json$/)) {
          const content = await zipEntry.async('string');

          // 言語を取得
          let language = 'unknown';
          try {
            const parsed = JSON.parse(content) as ProofFile;
            language = parsed.language ?? 'unknown';
          } catch {
            // パース失敗は無視
          }

          proofFiles.push({ name: filename, content, language });
        }
      }

      if (proofFiles.length === 0) {
        updateLoadingLog(extractLog, 'error', 'TC_*.json ファイルが見つかりません');
        showError('ZIPに証明ファイルがありません', 'TC_*.json パターンのファイルが含まれていません');
        setTimeout(() => resetDropZoneLoading((f) => this.handleFile(f)), 2000);
        return;
      }

      updateLoadingLog(extractLog, 'success', `${proofFiles.length} 件の証明ファイルを検出`);

      // UIを切り替え
      this.switchToMultiFileUI();

      // 各ファイルのタブを作成してキューに追加
      for (const pf of proofFiles) {
        const id = crypto.randomUUID();

        const tab: VerifyTabState = {
          id,
          filename: pf.name,
          language: pf.language,
          status: 'pending',
          progress: 0,
          proofData: null,
          verificationResult: null,
        };

        this.tabManager!.addTab(tab);

        this.verificationQueue!.enqueue({
          id,
          filename: pf.name,
          rawData: pf.content,
        });
      }

      // ファイルリストUIを更新
      this.fileListController?.updateUI();
      this.statusBar?.show();
      this.updateStatusBar();

    } catch (error) {
      console.error('[Verify] Error reading ZIP:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLoadingLog(`エラー: ${errorMessage}`, 'error');
      showError('ZIPファイルの読み込みに失敗しました', errorMessage);
      setTimeout(() => resetDropZoneLoading((f) => this.handleFile(f)), 2000);
    }
  }

  /**
   * 単体JSONファイルをマルチファイルモードで処理
   */
  private async handleJsonFileMultiMode(file: File): Promise<void> {
    // マルチファイルモードを初期化
    this.initializeMultiFileMode();

    showDropZoneLoading(file.name);
    const readLog = addLoadingLog('ファイルを読み込み中...');

    try {
      const text = await file.text();
      const fileSize = (text.length / 1024).toFixed(1);
      updateLoadingLog(readLog, 'success', `ファイル読み込み完了 (${fileSize} KB)`);

      // 言語を取得
      let language = 'unknown';
      try {
        const parsed = JSON.parse(text) as ProofFile;
        language = parsed.language ?? 'unknown';
      } catch {
        // パース失敗は無視
      }

      // UIを切り替え
      this.switchToMultiFileUI();

      const id = crypto.randomUUID();

      const tab: VerifyTabState = {
        id,
        filename: file.name,
        language,
        status: 'pending',
        progress: 0,
        proofData: null,
        verificationResult: null,
      };

      this.tabManager!.addTab(tab);

      this.verificationQueue!.enqueue({
        id,
        filename: file.name,
        rawData: text,
      });

      // ファイルリストUIを更新
      this.fileListController?.updateUI();
      this.statusBar?.show();
      this.updateStatusBar();

    } catch (error) {
      console.error('[Verify] Error reading file:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLoadingLog(`エラー: ${errorMessage}`, 'error');
      showError('ファイルの読み込みに失敗しました', errorMessage);
      setTimeout(() => resetDropZoneLoading((f) => this.handleFile(f)), 2000);
    }
  }

  /**
   * マルチファイルUIに切り替え
   */
  private switchToMultiFileUI(): void {
    const { dropZoneSection, verifyMain, verifyStatusbar } = this.options;

    hideDropZone();
    if (dropZoneSection) dropZoneSection.classList.add('hidden');
    if (verifyMain) verifyMain.style.display = 'flex';
    if (verifyStatusbar) verifyStatusbar.style.display = 'flex';
  }
}
