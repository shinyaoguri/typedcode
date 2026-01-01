/**
 * AppController - Main orchestration for the Verify application
 */
import { ThemeManager } from './ThemeManager';
import { ActivityBar } from './ActivityBar';
import { Sidebar, type FileStatus } from './Sidebar';
import { TabBar, type TabStatus } from './TabBar';
import { StatusBarUI } from './StatusBarUI';
import { WelcomePanel } from './WelcomePanel';
import { ResultPanel } from './ResultPanel';
import { VerifyTabManager } from '../state/VerifyTabManager';
import { VerificationQueue } from '../state/VerificationQueue';
import { UIStateManager } from '../state/UIStateManager';
import { FileProcessor, type ParsedFileData } from '../services/FileProcessor';
import { FileSystemAccessService } from '../services/FileSystemAccessService';
import { FolderSyncManager } from '../services/FolderSyncManager';
import { ScreenshotService } from '../services/ScreenshotService';
import { TimelineChart } from '../charts/TimelineChart';
import { MouseChart } from '../charts/MouseChart';
import { IntegratedChart } from '../charts/IntegratedChart';
import { ScreenshotOverlay } from '../charts/ScreenshotOverlay';
import { SeekbarController } from '../charts/SeekbarController';
import { ScreenshotLightbox } from './ScreenshotLightbox';
import { TabController } from './controllers/TabController';
import { t, getI18n } from '../i18n/index';
import { showAboutDialog } from './AboutDialog';
import type {
  ProofFile,
  FSAccessFileEntry,
  HierarchicalFolder,
  ProgressDetails,
  VerifyScreenshot,
} from '../types';

export class AppController {
  private themeManager: ThemeManager;
  private activityBar: ActivityBar;
  private sidebar: Sidebar;
  private tabBar: TabBar;
  private statusBar: StatusBarUI;
  private welcomePanel: WelcomePanel;
  private resultPanel: ResultPanel;

  private tabManager: VerifyTabManager;
  private verificationQueue: VerificationQueue;
  private fileProcessor: FileProcessor;
  private uiState: UIStateManager;
  private tabController: TabController;

  // File System Access API
  private fsAccessService: FileSystemAccessService;
  private syncManager: FolderSyncManager;
  private watchedRootHandle: FileSystemDirectoryHandle | null = null;
  private watchedRootFolderId: string | null = null;

  private timelineChart: TimelineChart | null = null;
  private mouseChart: MouseChart | null = null;

  // IntegratedChart関連
  private integratedChart: IntegratedChart | null = null;
  private screenshotOverlay: ScreenshotOverlay | null = null;
  private screenshotLightbox: ScreenshotLightbox | null = null;
  private seekbarController: SeekbarController | null = null;
  private screenshotService: ScreenshotService | null = null;

  private fileInput: HTMLInputElement;

  constructor() {
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;

    // Initialize theme
    this.themeManager = new ThemeManager();

    // Initialize File System Access API
    this.fsAccessService = new FileSystemAccessService({
      onPermissionDenied: (error) => {
        this.statusBar.setError(`${t('errors.accessDenied')}: ${error.message}`);
      },
    });

    this.syncManager = new FolderSyncManager({
      onFileAdded: (file) => this.handleExternalFileAdded(file),
      onFileModified: (file) => this.handleExternalFileModified(file),
      onFileDeleted: (path) => this.handleExternalFileDeleted(path),
      onFolderAdded: (path, name) => this.handleExternalFolderAdded(path, name),
      onFolderDeleted: (path) => this.handleExternalFolderDeleted(path),
      onSyncComplete: () => {
        // 同期完了時の処理（必要に応じて）
      },
      onSyncError: (error) => {
        console.error('Sync error:', error);
      },
    });

    // Initialize UI components
    this.activityBar = new ActivityBar({
      onOpenFile: () => this.openFileDialog(),
      onOpenFolder: () => this.openFolderDialog(),
      onThemeToggle: () => this.themeManager.toggle(),
      onExplorerToggle: () => this.toggleSidebar(),
      onLanguageToggle: () => this.toggleLanguage(),
      onAbout: () => showAboutDialog(getI18n()),
    });

    this.sidebar = new Sidebar({
      onFileSelect: (id) => this.handleFileSelect(id),
      onAddFile: () => this.openFileDialog(),
      onAddFolder: () => this.openFolderDialog(),
      onFileRemove: (id) => this.handleFileRemove(id),
      onFilesDropped: (files) => this.handleFilesSelected(files),
      onFolderRemove: (folderId) => this.handleFolderRemove(folderId),
    });

    this.tabBar = new TabBar({
      onTabSelect: (id) => this.handleTabSelect(id),
      onTabClose: (id) => this.handleTabClose(id),
    });

    this.statusBar = new StatusBarUI();
    this.welcomePanel = new WelcomePanel({
      onFilesSelected: (files) => this.handleFilesSelected(files),
    });
    this.resultPanel = new ResultPanel();

    // Initialize state management
    this.uiState = new UIStateManager();
    this.tabManager = new VerifyTabManager();
    this.tabManager.setOnChange((tab) => {
      this.showTabContent(tab.id);
    });

    this.verificationQueue = new VerificationQueue();
    this.verificationQueue.setOnProgress((params) => {
      this.handleVerificationProgress(params.id, params.progress, params.details);
    });
    this.verificationQueue.setOnComplete((id, result) => {
      this.handleVerificationComplete(id, result);
    });
    this.verificationQueue.setOnError((id, error) => {
      this.handleVerificationError(id, error);
    });
    this.verificationQueue.initialize();

    this.fileProcessor = new FileProcessor();

    // Initialize TabController
    this.tabController = new TabController({
      tabManager: this.tabManager,
      uiState: this.uiState,
      tabBar: this.tabBar,
      sidebar: this.sidebar,
      resultPanel: this.resultPanel,
      welcomePanel: this.welcomePanel,
      getTimelineChart: () => this.timelineChart,
      getMouseChart: () => this.mouseChart,
      // IntegratedChart関連
      getIntegratedChart: () => this.integratedChart,
      getScreenshotOverlay: () => this.screenshotOverlay,
      getScreenshotLightbox: () => this.screenshotLightbox,
      getSeekbarController: () => this.seekbarController,
    });

    // File input change handler
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.handleFilesSelected(this.fileInput.files);
        this.fileInput.value = '';
      }
    });

    // Initialize charts (lazy)
    this.initializeCharts();

    // ページ離脱時の確認ダイアログ
    this.setupBeforeUnloadHandler();

    // 結果パネルのリサイズ機能
    this.setupResultPanelResize();
  }

  /**
   * サイドバーの表示/非表示を切り替え
   */
  private toggleSidebar(): void {
    const sidebarEl = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('resize-handle');
    if (sidebarEl) {
      sidebarEl.classList.toggle('collapsed');
    }
    if (resizeHandle) {
      resizeHandle.style.display = sidebarEl?.classList.contains('collapsed') ? 'none' : '';
    }
  }

  /**
   * 言語を切り替え
   */
  private toggleLanguage(): void {
    const i18n = getI18n();
    const currentLocale = i18n.getLocale();
    const newLocale = currentLocale === 'ja' ? 'en' : 'ja';
    i18n.setLocale(newLocale);
    // ページをリロードして新しい言語を適用
    window.location.reload();
  }

  /**
   * 結果パネルのリサイズ機能を設定
   */
  private setupResultPanelResize(): void {
    const resizeHandle = document.getElementById('result-resize-handle');
    const leftPanel = document.getElementById('result-left-panel');
    const resultContent = document.querySelector('.result-content') as HTMLElement;

    if (!resizeHandle || !leftPanel || !resultContent) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = leftPanel.offsetWidth;
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const delta = e.clientX - startX;
      const newWidth = startWidth + delta;
      const containerWidth = resultContent.offsetWidth;

      // 最小幅350px、最大70%
      const minWidth = 350;
      const maxWidth = containerWidth * 0.7;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        leftPanel.style.width = `${newWidth}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  /**
   * ページ離脱・リロード時の確認ダイアログを設定
   */
  private setupBeforeUnloadHandler(): void {
    window.addEventListener('beforeunload', (event) => {
      // ファイルが読み込まれている場合のみ確認
      if (this.sidebar.getFileCount() > 0 || this.sidebar.getFolderCount() > 0) {
        event.preventDefault();
        // 標準的な方法（ブラウザによってはカスタムメッセージは表示されない）
        event.returnValue = '';
        return '';
      }
    });
  }

  private initializeCharts(): void {
    const timelineCanvas = document.getElementById('integrated-timeline-chart') as HTMLCanvasElement;
    const mouseCanvas = document.getElementById('mouse-trajectory-chart') as HTMLCanvasElement;
    const integratedCanvas = document.getElementById('integrated-chart') as HTMLCanvasElement;

    // 既存のTimelineChart/MouseChart（後方互換性）
    if (timelineCanvas) {
      this.timelineChart = new TimelineChart({ canvas: timelineCanvas });
    }

    if (mouseCanvas) {
      this.mouseChart = new MouseChart({ canvas: mouseCanvas });
    }

    // IntegratedChart (Chart.js) を初期化
    if (integratedCanvas) {
      // ScreenshotServiceを先に初期化
      this.screenshotService = new ScreenshotService();

      // ScreenshotOverlay (ホバープレビュー)
      this.screenshotOverlay = new ScreenshotOverlay(this.screenshotService);

      // ScreenshotLightbox
      this.screenshotLightbox = new ScreenshotLightbox({
        screenshotService: this.screenshotService,
        onNavigate: (screenshot) => {
          // ライトボックスでナビゲート時、チャートマーカーを更新
          if (this.integratedChart) {
            this.integratedChart.updateMarker(screenshot.timestamp);
          }
        },
      });

      // IntegratedChart
      this.integratedChart = new IntegratedChart({
        canvas: integratedCanvas,
        onScreenshotHover: (screenshot, x, y) => {
          if (screenshot && this.screenshotOverlay) {
            this.screenshotOverlay.show(screenshot, x, y);
          } else if (this.screenshotOverlay) {
            this.screenshotOverlay.hide();
          }
        },
        onScreenshotClick: (screenshot) => {
          if (this.screenshotLightbox) {
            this.screenshotLightbox.open(screenshot);
          }
        },
        onTimeSelect: (timestamp, eventIndex) => {
          // シークバーと連携
          if (this.seekbarController) {
            this.seekbarController.seekToTime(timestamp);
          }
        },
      });

      // SeekbarControllerにIntegratedChartを連携
      if (this.seekbarController) {
        this.seekbarController.setIntegratedChart(this.integratedChart);
      }
    }

    // SeekbarController を初期化
    const codePreview = document.querySelector('#code-preview code') as HTMLElement | null;
    this.seekbarController = new SeekbarController(
      {
        floatingSeekbar: document.getElementById('chart-seekbar'),
        slider: document.getElementById('seekbar-slider') as HTMLInputElement | null,
        progressBar: document.getElementById('seekbar-progress'),
        timeDisplay: document.getElementById('seekbar-time'),
        eventCountDisplay: document.getElementById('seekbar-event-count'),
        startButton: document.getElementById('seekbar-start'),
        prevButton: document.getElementById('seekbar-prev'),
        playButton: document.getElementById('seekbar-play'),
        playIcon: document.getElementById('play-icon'),
        nextButton: document.getElementById('seekbar-next'),
        endButton: document.getElementById('seekbar-end'),
        contentPreview: codePreview,
      },
      {
        onSeek: (eventIndex) => {
          // シーク時にコードプレビューを更新
          this.updateCodePreview(eventIndex);
        },
      }
    );
    this.seekbarController.setupEventListeners();

    // IntegratedChartが既に存在する場合は連携
    if (this.integratedChart) {
      this.seekbarController.setIntegratedChart(this.integratedChart);
    }
  }

  /**
   * スクリーンショットサービスを更新し、関連コンポーネントに伝播
   * ZIP/フォルダ両方の読み込みパスで一貫した動作を保証
   */
  private updateScreenshotService(screenshotService: ScreenshotService): void {
    // 古いサービスを破棄
    if (this.screenshotService) {
      this.screenshotService.dispose();
    }

    this.screenshotService = screenshotService;

    // ScreenshotOverlay を再作成
    if (this.screenshotOverlay) {
      this.screenshotOverlay.destroy();
    }
    this.screenshotOverlay = new ScreenshotOverlay(this.screenshotService);

    // ScreenshotLightbox を再作成
    if (this.screenshotLightbox) {
      this.screenshotLightbox.destroy();
    }
    this.screenshotLightbox = new ScreenshotLightbox({
      screenshotService: this.screenshotService,
      onNavigate: (screenshot) => {
        if (this.integratedChart) {
          this.integratedChart.updateMarker(screenshot.timestamp);
        }
      },
    });
  }

  /**
   * コードプレビューを更新
   */
  private updateCodePreview(eventIndex: number): void {
    const codePreview = document.querySelector('#code-preview code') as HTMLElement | null;
    if (!codePreview || !this.seekbarController) return;

    const content = this.seekbarController.getContentAtIndex(eventIndex);
    codePreview.textContent = content;
  }

  private openFileDialog(): void {
    this.fileInput.click();
  }

  private async handleFilesSelected(files: FileList): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await this.processFile(file);
    }
  }

  private async processFile(file: File): Promise<void> {
    try {
      const result = await this.fileProcessor.process(file);

      if (!result.success) {
        this.statusBar.setError(result.error || t('errors.fileReadError'));
        return;
      }

      // ZIPファイルの場合はフォルダ階層を作成
      let rootFolderId: string | undefined;
      const folderMap = new Map<string, string>(); // path -> folderId

      if (file.name.endsWith('.zip') && result.folderPaths) {
        rootFolderId = this.createFolderForZip(file.name);
        folderMap.set('', rootFolderId);

        // フォルダパスをソート（親フォルダが先に処理されるように）
        const sortedPaths = result.folderPaths.sort((a, b) => a.localeCompare(b));

        for (const folderPath of sortedPaths) {
          const folderId = this.generateId();
          const parts = folderPath.split('/');
          const folderName = parts[parts.length - 1];
          const parentPath = parts.slice(0, -1).join('/');
          const parentId = folderMap.get(parentPath) ?? rootFolderId;
          const depth = parts.length;

          // screenshotsフォルダはデフォルトで閉じた状態
          const isScreenshotsFolder = folderName === 'screenshots' || folderPath.startsWith('screenshots/');
          const expanded = isScreenshotsFolder ? false : depth <= 1;

          this.sidebar.addHierarchicalFolder({
            id: folderId,
            name: folderName,
            path: folderPath,
            parentId,
            expanded,
            depth,
          });
          folderMap.set(folderPath, folderId);
        }
      } else if (file.name.endsWith('.zip')) {
        rootFolderId = this.createFolderForZip(file.name);
        folderMap.set('', rootFolderId);
      }

      // スクリーンショットサービスを保存（ZIPに含まれている場合）
      if (result.screenshotService) {
        this.updateScreenshotService(result.screenshotService);
      }

      for (const fileData of result.files) {
        // ファイルの親フォルダを特定
        let folderId = rootFolderId;
        if (fileData.relativePath) {
          const parts = fileData.relativePath.split('/');
          const parentPath = parts.slice(0, -1).join('/');
          folderId = folderMap.get(parentPath) ?? rootFolderId;
        }

        if (fileData.type === 'proof') {
          this.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath, result.screenshots, result.startTimestamp);
        } else if (fileData.type === 'image') {
          this.addImageFile(fileData, folderId);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }
    } catch (error) {
      console.error('Error processing file:', error);
      this.statusBar.setError(`${t('errors.fileReadError')}: ${file.name}`);
    }
  }

  private createFolderForZip(zipFilename: string): string {
    const folderId = this.generateId();
    // ZIPファイル名から拡張子を除去してフォルダ名とする
    const folderName = this.generateFolderName(zipFilename.replace(/\.zip$/i, ''));

    this.sidebar.addFolder({
      id: folderId,
      name: folderName,
      expanded: true, // デフォルトで展開
    });

    return folderId;
  }

  private generateFolderName(baseName: string): string {
    return this.uiState.generateFolderName(baseName);
  }

  /**
   * プレーンテキストファイルを追加（読み取り専用）
   */
  private addPlaintextFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.generateId();
    const displayName = this.generateDisplayName(fileData.filename, folderId);

    // Add to tab manager (plaintext file - no verification)
    this.tabManager.addTab({
      id,
      filename: displayName,
      language: fileData.language,
      status: 'success', // プレーンテキストは常に「成功」状態
      progress: 100,
      proofData: null,
      verificationResult: null,
      isPlaintext: true, // プレーンテキストフラグ
      plaintextContent: fileData.rawData,
    });

    // Add to sidebar (file list)
    this.sidebar.addFile({
      id,
      filename: displayName,
      status: 'success', // プレーンテキストはグレーアイコン（成功扱い）
      folderId,
      isProof: false, // プレーンテキストファイル
    });

    // タブは開かない（ユーザがファイル一覧から選択した時に開く）

    this.updateStatusBar();
  }

  /**
   * 画像ファイルを追加（プレビュー表示用）
   */
  private addImageFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.generateId();
    const displayName = this.generateDisplayName(fileData.filename, folderId);

    // Add to tab manager (image file - no verification)
    this.tabManager.addTab({
      id,
      filename: displayName,
      language: 'image',
      status: 'success', // 画像ファイルは常に「成功」状態
      progress: 100,
      proofData: null,
      verificationResult: null,
      isImage: true,
      imageBlob: fileData.imageBlob,
    });

    // Add to sidebar (file list)
    this.sidebar.addFile({
      id,
      filename: displayName,
      status: 'success',
      folderId,
      isProof: false,
      isImage: true, // 画像ファイル
    });

    this.updateStatusBar();
  }

  private addFileToVerification(
    filename: string,
    rawData: string,
    folderId?: string,
    relativePath?: string,
    screenshots?: VerifyScreenshot[],
    startTimestamp?: number
  ): void {
    console.log('[AppController] addFileToVerification:', {
      filename,
      screenshotsCount: screenshots?.length ?? 0,
      startTimestamp,
    });

    try {
      const proofData = JSON.parse(rawData) as ProofFile;
      const id = this.generateId();

      // 表示名を生成（重複がある場合は番号を付ける）
      const displayName = this.generateDisplayName(filename, folderId);

      // startTimestampが渡されていない場合は計算
      let computedStartTimestamp = startTimestamp;
      if (!computedStartTimestamp && proofData.metadata?.timestamp && proofData.proof?.events?.length > 0) {
        const exportedAt = proofData.metadata.timestamp;
        const totalTime = proofData.proof.events[proofData.proof.events.length - 1]?.timestamp ?? 0;
        const exportTimestamp = new Date(exportedAt).getTime();
        computedStartTimestamp = exportTimestamp - totalTime;
      }

      // Add to tab manager (state management)
      this.tabManager.addTab({
        id,
        filename: displayName,
        language: proofData.language || 'unknown',
        status: 'pending',
        progress: 0,
        proofData,
        verificationResult: null,
        screenshots, // スクリーンショットを保存
        startTimestamp: computedStartTimestamp,
      });

      // Add to sidebar (file list)
      this.sidebar.addFile({
        id,
        filename: displayName,
        status: 'pending',
        folderId, // フォルダに属する場合
        relativePath, // File System Access API用のパス
        isProof: true, // 検証用ファイル
      });

      // タブは開かない（ユーザがファイル一覧から選択した時に開く）

      // Track counts
      this.uiState.incrementTotal();

      // Enqueue for verification
      this.verificationQueue.enqueue({
        id,
        filename,
        rawData,
      });

      // Update status bar
      this.updateStatusBar();
    } catch (error) {
      console.error('Error parsing JSON:', error);
      this.statusBar.setError(`JSONパースエラー: ${filename}`);
    }
  }

  private openTabForFile(id: string): void {
    this.tabController.openTabForFile(id);
  }

  private handleFileSelect(id: string): void {
    this.tabController.handleFileSelect(id);
  }

  private handleTabSelect(id: string): void {
    this.tabController.handleTabSelect(id);
  }

  private handleTabClose(id: string): void {
    this.tabController.handleTabClose(id);
    this.updateStatusBar();
  }

  private handleFileRemove(id: string): void {
    // 削除するファイルが表示中の場合、表示状態をリセット
    if (this.uiState.isDisplayed(id)) {
      this.uiState.setCurrentDisplayedTabId(null);
    }

    // ファイル一覧から削除する場合は、タブとTabManagerからも削除
    this.tabManager.removeTab(id);
    this.tabBar.removeTab(id);
    this.sidebar.removeFile(id);

    // If no files left, show welcome panel
    if (this.sidebar.getFileCount() === 0 && this.sidebar.getFolderCount() === 0) {
      this.resultPanel.hide();
      this.welcomePanel.show();
    }

    this.updateStatusBar();
  }

  private handleFolderRemove(folderId: string): void {
    // フォルダ内のファイルIDを取得
    const fileIds = this.sidebar.getFilesInFolder(folderId);

    // フォルダ内のファイルをタブとTabManagerから削除
    for (const fileId of fileIds) {
      // 表示中のファイルの場合、表示状態をリセット
      if (this.uiState.isDisplayed(fileId)) {
        this.uiState.setCurrentDisplayedTabId(null);
      }
      this.tabManager.removeTab(fileId);
      this.tabBar.removeTab(fileId);
    }

    // サイドバーからフォルダを削除（中のファイルも一緒に削除される）
    this.sidebar.removeFolder(folderId);

    // If no files left, show welcome panel
    if (this.sidebar.getFileCount() === 0 && this.sidebar.getFolderCount() === 0) {
      this.resultPanel.hide();
      this.welcomePanel.show();
    }

    this.updateStatusBar();
  }

  private showTabContent(id: string, forceRefresh: boolean = false): void {
    this.tabController.showTabContent(id, forceRefresh);
  }

  private handleVerificationProgress(id: string, progress: number, details?: ProgressDetails): void {
    const tabState = this.tabManager.getTab(id);

    // 既に完了しているタブへの進捗更新はスキップ（遅延メッセージ対策）
    if (tabState?.status === 'success' || tabState?.status === 'warning' || tabState?.status === 'error') {
      return;
    }

    const statusChanged = tabState?.status !== 'verifying';

    this.tabManager.updateTab(id, { progress, status: 'verifying', progressDetails: details });

    // ステータスが変わった場合のみフル更新、そうでなければ進捗のみ更新（チカチカ防止）
    if (statusChanged) {
      this.sidebar.updateFileStatus(id, 'verifying', progress);
    } else {
      this.sidebar.updateFileProgress(id, progress);
    }

    // タブが開いている場合のみ更新
    if (this.tabBar.hasTab(id)) {
      this.tabBar.updateTabStatus(id, 'verifying', progress);
    }

    // アクティブタブの場合、詳細な進捗UIを更新
    if (this.tabBar.getActiveTabId() === id && details) {
      this.tabController.updateVerificationProgressUI(details, progress);
    }

    this.updateStatusBar();
  }

  private handleVerificationComplete(id: string, result: any): void {
    console.log('[DEBUG] handleVerificationComplete called', { id, chainValid: result.chainValid });

    const status: FileStatus = result.chainValid
      ? result.isPureTyping
        ? 'success'
        : 'warning'
      : 'error';

    this.uiState.incrementCompleted();
    const state = this.uiState.getState();
    console.log('[DEBUG] completedCount:', state.completedCount, 'totalCount:', state.totalCount);

    this.tabManager.updateTab(id, { verificationResult: result, status });
    console.log('[DEBUG] tabManager.updateTab done, new status:', status);

    this.sidebar.updateFileStatus(id, status);

    // タブが開いている場合のみ更新
    if (this.tabBar.hasTab(id)) {
      this.tabBar.updateTabStatus(id, status as TabStatus);
    }

    // アクティブタブの場合、結果を表示
    if (this.tabBar.getActiveTabId() === id) {
      this.resultPanel.finishProgress();
      // 強制更新フラグを渡して結果を確実に表示
      this.showTabContent(id, true);
    }

    // 検証完了後、確実にステータスバーを更新
    // setTimeout を使って次のイベントループで更新することで
    // 全ての状態更新が反映された後に実行される
    console.log('[DEBUG] scheduling updateStatusBar via setTimeout');
    setTimeout(() => {
      console.log('[DEBUG] setTimeout callback executing updateStatusBar');
      this.updateStatusBar();
    }, 0);
  }

  private handleVerificationError(id: string, error: string): void {
    this.uiState.incrementCompleted();
    this.tabManager.updateTab(id, { status: 'error', error });
    this.sidebar.updateFileStatus(id, 'error');
    // タブが開いている場合のみ更新
    if (this.tabBar.hasTab(id)) {
      this.tabBar.updateTabStatus(id, 'error');
    }

    if (this.tabBar.getActiveTabId() === id) {
      // 進捗UIをエラー状態に
      this.resultPanel.errorProgress('chain', error);
      this.statusBar.setError(error);
    }

    // 検証完了後、確実にステータスバーを更新
    setTimeout(() => this.updateStatusBar(), 0);
  }

  private updateStatusBar(): void {
    const fileCount = this.sidebar.getFileCount();
    this.statusBar.setFileCount(fileCount);

    // TabManagerの状態に基づいて検証中かどうかを判定
    // （VerificationQueueの状態は非同期で遅延する可能性があるため）
    let pendingOrVerifyingCount = 0;
    const allTabs = this.tabManager.getAllTabs();
    console.log('[DEBUG] updateStatusBar - allTabs:', allTabs.map(t => ({ id: t.id, status: t.status, filename: t.filename })));

    for (const tab of allTabs) {
      if (tab.status === 'pending' || tab.status === 'verifying') {
        pendingOrVerifyingCount++;
      }
    }

    console.log('[DEBUG] updateStatusBar - pendingOrVerifyingCount:', pendingOrVerifyingCount);

    if (pendingOrVerifyingCount > 0) {
      console.log('[DEBUG] updateStatusBar - calling setVerifying');
      const state = this.uiState.getState();
      this.statusBar.setVerifying(state.completedCount, state.totalCount);
    } else {
      console.log('[DEBUG] updateStatusBar - calling setReady');
      this.statusBar.setReady();
    }
  }

  // ==========================================================================
  // File System Access API メソッド
  // ==========================================================================

  /**
   * フォルダ選択ダイアログを開く
   */
  private async openFolderDialog(): Promise<void> {
    if (!FileSystemAccessService.isSupported()) {
      this.showUnsupportedBrowserDialog();
      return;
    }

    const handle = await this.fsAccessService.showDirectoryPicker();
    if (!handle) return;

    // 既存の監視を停止
    this.syncManager.stopWatching();

    // ディレクトリを読み取り
    const result = await this.fsAccessService.readDirectoryRecursive(handle);
    if (!result.success) {
      this.statusBar.setError(result.error ?? t('errors.folderReadError'));
      return;
    }

    // スクリーンショットフォルダを検出して読み込む
    let folderScreenshots: VerifyScreenshot[] | undefined;
    let folderStartTimestamp: number | undefined;
    try {
      const loadResult = await this.loadScreenshotsFromFolder(handle);
      if (loadResult) {
        folderScreenshots = loadResult.screenshots;
        folderStartTimestamp = loadResult.startTimestamp;
        console.log(`[AppController] Loaded ${folderScreenshots.length} screenshots from folder`);
      }
    } catch (error) {
      console.log('[AppController] No screenshots folder found or error loading:', error);
    }

    // ルートフォルダを作成
    const rootFolderId = this.generateId();
    const rootFolder: HierarchicalFolder = {
      id: rootFolderId,
      name: result.rootName,
      path: '',
      parentId: null,
      expanded: true,
      depth: 0,
      sourceType: 'fsaccess',
      directoryHandle: handle,
    };

    this.sidebar.addHierarchicalFolder(rootFolder);
    this.watchedRootFolderId = rootFolderId;

    // サブフォルダを追加（screenshotsフォルダも含める）
    const folderMap = new Map<string, string>(); // path -> folderId
    folderMap.set('', rootFolderId);

    // フォルダをソートしてから追加（親フォルダが先に処理されるように）
    const sortedFolders = result.folders
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const folder of sortedFolders) {
      const folderId = this.generateId();
      const parentPath = folder.path.split('/').slice(0, -1).join('/');
      const parentId = folderMap.get(parentPath) ?? rootFolderId;
      const depth = folder.path.split('/').length;

      // screenshotsフォルダはデフォルトで閉じた状態
      const isScreenshotsFolder = folder.name === 'screenshots' || folder.path.startsWith('screenshots/');
      const expanded = isScreenshotsFolder ? false : depth <= 1;

      const hierarchicalFolder: HierarchicalFolder = {
        id: folderId,
        name: folder.name,
        path: folder.path,
        parentId,
        expanded,
        depth,
        sourceType: 'fsaccess',
        directoryHandle: folder.handle,
      };

      this.sidebar.addHierarchicalFolder(hierarchicalFolder);
      folderMap.set(folder.path, folderId);
    }

    // ファイルを処理（スクリーンショット情報を渡す）
    for (const fileEntry of result.files) {
      await this.processFileFromHandle(fileEntry, folderMap, folderScreenshots, folderStartTimestamp);
    }

    // 監視を開始
    this.watchedRootHandle = handle;
    await this.syncManager.startWatching(handle, 3000);

    this.updateStatusBar();
    this.statusBar.setMessage(`${t('messages.folderOpened')}: ${result.rootName}`);
  }

  /**
   * フォルダからスクリーンショットを読み込む
   */
  private async loadScreenshotsFromFolder(
    rootHandle: FileSystemDirectoryHandle
  ): Promise<{ screenshots: VerifyScreenshot[]; startTimestamp?: number } | null> {
    try {
      // screenshots フォルダを取得
      const screenshotsFolderHandle = await rootHandle.getDirectoryHandle('screenshots');

      // manifest.json を読み込む
      const manifestHandle = await screenshotsFolderHandle.getFileHandle('manifest.json');
      const manifestFile = await manifestHandle.getFile();
      const manifestText = await manifestFile.text();
      const manifest = JSON.parse(manifestText) as import('../types').ScreenshotManifest;

      // ScreenshotServiceを作成してスクリーンショットを読み込む
      const screenshotService = new ScreenshotService();
      const screenshots = await screenshotService.loadFromFolder(screenshotsFolderHandle, manifest);

      // startTimestampを計算（最初のスクリーンショットのタイムスタンプから）
      let startTimestamp: number | undefined;
      if (screenshots.length > 0) {
        const firstScreenshot = screenshots.reduce((min, s) => (s.timestamp < min.timestamp ? s : min), screenshots[0]);
        // エクスポート時刻からtimestampを引いてstartTimestampを計算
        const exportedAt = new Date(manifest.exportedAt).getTime();
        const lastTimestamp = screenshots.reduce((max, s) => Math.max(max, s.timestamp), 0);
        startTimestamp = exportedAt - lastTimestamp;
      }

      // サービスを保持し、UIコンポーネントを更新
      this.updateScreenshotService(screenshotService);

      return { screenshots, startTimestamp };
    } catch {
      // screenshots フォルダが存在しない場合
      return null;
    }
  }

  /**
   * FileSystemFileHandle からファイルを処理
   */
  private async processFileFromHandle(
    fileEntry: FSAccessFileEntry,
    folderMap: Map<string, string>,
    folderScreenshots?: VerifyScreenshot[],
    folderStartTimestamp?: number
  ): Promise<void> {
    const filename = fileEntry.name;

    // 隠しファイル（.で始まるファイル）はスキップ
    if (filename.startsWith('.')) return;

    const parentPath = fileEntry.path.split('/').slice(0, -1).join('/');
    const folderId = folderMap.get(parentPath);

    // 画像ファイルかどうかを判定
    const isImage = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(filename);

    // screenshots フォルダ内のファイルを特別処理
    if (fileEntry.path.startsWith('screenshots/')) {
      if (isImage) {
        // 画像ファイルをファイル一覧に追加（クリックでプレビュー表示）
        try {
          const file = await fileEntry.handle.getFile();
          const blob = new Blob([await file.arrayBuffer()], { type: file.type });
          this.addImageFile({
            filename,
            type: 'image',
            language: 'image',
            rawData: '',
            relativePath: fileEntry.path,
            imageBlob: blob,
          }, folderId);
        } catch (error) {
          console.error('Error loading image:', fileEntry.path, error);
        }
        return;
      }
      // manifest.json やその他のテキストファイルは通常処理
    }

    try {
      const result = await this.fileProcessor.processFromHandle(
        fileEntry.handle,
        fileEntry.path
      );

      if (!result.success) {
        return;
      }

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          // フォルダからスクリーンショットが読み込まれている場合は渡す
          this.addFileToVerification(
            fileData.filename,
            fileData.rawData,
            folderId,
            fileData.relativePath,
            folderScreenshots,
            folderStartTimestamp
          );
        } else if (fileData.type === 'image') {
          this.addImageFile(fileData, folderId);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }
    } catch (error) {
      console.error('Error processing file:', fileEntry.path, error);
    }
  }

  /**
   * 外部でファイルが追加された時の処理
   */
  private async handleExternalFileAdded(file: FSAccessFileEntry): Promise<void> {
    const parentPath = file.path.split('/').slice(0, -1).join('/');
    const folderId = this.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId ?? undefined;

    try {
      const result = await this.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success) return;

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          this.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }

      this.statusBar.setMessage(`${t('messages.fileAdded')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing added file:', error);
    }
  }

  /**
   * 外部でファイルが変更された時の処理
   */
  private async handleExternalFileModified(file: FSAccessFileEntry): Promise<void> {
    const existingFileId = this.sidebar.getFileIdByPath(file.path);
    if (!existingFileId) return;

    try {
      const result = await this.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success || result.files.length === 0) return;

      const fileData = result.files[0];
      if (!fileData) return;

      const tabState = this.tabManager.getTab(existingFileId);

      if (tabState) {
        // 既存のタブ状態を更新
        if (fileData.type === 'proof') {
          // 検証ファイルの場合、再検証
          this.tabManager.updateTab(existingFileId, {
            status: 'pending',
            progress: 0,
            verificationResult: null,
          });
          this.sidebar.updateFileStatus(existingFileId, 'pending');
          this.tabBar.updateTabStatus(existingFileId, 'pending', 0);

          this.verificationQueue.enqueue({
            id: existingFileId,
            filename: fileData.filename,
            rawData: fileData.rawData,
          });
        } else {
          // プレーンテキストの場合、内容を更新
          this.tabManager.updateTab(existingFileId, {
            plaintextContent: fileData.rawData,
          });

          // アクティブタブなら再表示
          if (this.tabBar.getActiveTabId() === existingFileId) {
            this.showTabContent(existingFileId);
          }
        }
      }

      this.statusBar.setMessage(`${t('messages.fileUpdated')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing modified file:', error);
    }
  }

  /**
   * 外部でファイルが削除された時の処理
   */
  private handleExternalFileDeleted(path: string): void {
    const fileId = this.sidebar.getFileIdByPath(path);
    if (fileId) {
      this.handleFileRemove(fileId);
      const filename = path.split('/').pop() ?? path;
      this.statusBar.setMessage(`${t('messages.fileDeleted')}: ${filename}`);
    }
  }

  /**
   * 外部でフォルダが追加された時の処理
   */
  private handleExternalFolderAdded(path: string, name: string): void {
    const parentPath = path.split('/').slice(0, -1).join('/');
    const parentId = this.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId;
    const depth = path.split('/').length;

    const folder: HierarchicalFolder = {
      id: this.generateId(),
      name,
      path,
      parentId,
      expanded: false,
      depth,
      sourceType: 'fsaccess',
    };

    this.sidebar.addHierarchicalFolder(folder);
    this.statusBar.setMessage(`${t('messages.folderAdded')}: ${name}`);
  }

  /**
   * 外部でフォルダが削除された時の処理
   */
  private handleExternalFolderDeleted(path: string): void {
    this.sidebar.removeFolderByPath(path);
    const folderName = path.split('/').pop() ?? path;
    this.statusBar.setMessage(`${t('messages.folderDeleted')}: ${folderName}`);
  }

  /**
   * ブラウザ非対応ダイアログを表示
   */
  private showUnsupportedBrowserDialog(): void {
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay';
    dialog.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <i class="fas fa-exclamation-triangle" style="color: var(--warning-color);"></i>
          <h3>${t('errors.browserNotSupported')}</h3>
        </div>
        <div class="modal-body">
          <p>${t('errors.browserNotSupportedDesc')}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()">
            ${t('common.close')}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
  }

  private generateId(): string {
    return `verify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 表示名を生成（重複ファイル名の場合は番号を付与）
   * @param filename 元のファイル名
   * @param folderId フォルダID（フォルダに属する場合）
   */
  private generateDisplayName(filename: string, folderId?: string): string {
    return this.uiState.generateDisplayName(filename, folderId);
  }
}
