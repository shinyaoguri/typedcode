/**
 * AppController - Main orchestration for the Verify application
 * ファサードパターンで各コントローラーに処理を委譲
 */
import { ThemeManager } from './ThemeManager';
import { ActivityBar } from './ActivityBar';
import { Sidebar, type FileStatus } from './Sidebar';
import { TabBar } from './TabBar';
import { StatusBarUI } from './StatusBarUI';
import { WelcomePanel } from './WelcomePanel';
import { ResultPanel } from './ResultPanel';
import { VerifyTabManager } from '../state/VerifyTabManager';
import { VerificationQueue } from '../state/VerificationQueue';
import { UIStateManager } from '../state/UIStateManager';
import { FileProcessor } from '../services/FileProcessor';
import { TabController } from './controllers/TabController';
import { FileController } from './controllers/FileController';
import { VerificationController } from './controllers/VerificationController';
import { ChartController } from './controllers/ChartController';
import { FolderController } from './controllers/FolderController';
import { t, getI18n } from '../i18n/index';
import { showAboutDialog } from './AboutDialog';

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

  // Controllers
  private tabController: TabController;
  private fileController: FileController;
  private verificationController: VerificationController;
  private chartController: ChartController;
  private folderController: FolderController;

  private fileInput: HTMLInputElement;

  constructor() {
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;

    // Initialize theme
    this.themeManager = new ThemeManager();

    // Initialize UI components
    this.activityBar = new ActivityBar({
      onOpenFile: () => this.openFileDialog(),
      onOpenFolder: () => this.folderController.openFolderDialog(),
      onThemeToggle: () => this.themeManager.toggle(),
      onExplorerToggle: () => this.toggleSidebar(),
      onLanguageToggle: () => this.toggleLanguage(),
      onAbout: () => showAboutDialog(getI18n()),
    });

    this.sidebar = new Sidebar({
      onFileSelect: (id) => this.handleFileSelect(id),
      onAddFile: () => this.openFileDialog(),
      onAddFolder: () => this.folderController.openFolderDialog(),
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
    this.fileProcessor = new FileProcessor();

    // Initialize ChartController first (needed by other controllers)
    this.chartController = new ChartController();
    this.chartController.initialize();

    // Initialize TabController
    this.tabController = new TabController({
      tabManager: this.tabManager,
      uiState: this.uiState,
      tabBar: this.tabBar,
      sidebar: this.sidebar,
      resultPanel: this.resultPanel,
      welcomePanel: this.welcomePanel,
      getTimelineChart: () => this.chartController.getTimelineChart(),
      getMouseChart: () => this.chartController.getMouseChart(),
      getIntegratedChart: () => this.chartController.getIntegratedChart(),
      getScreenshotOverlay: () => this.chartController.getScreenshotOverlay(),
      getScreenshotLightbox: () => this.chartController.getScreenshotLightbox(),
      getSeekbarController: () => this.chartController.getSeekbarController(),
    });

    // Initialize VerificationController
    this.verificationController = new VerificationController({
      tabManager: this.tabManager,
      uiState: this.uiState,
      tabBar: this.tabBar,
      sidebar: this.sidebar,
      statusBar: this.statusBar,
      resultPanel: this.resultPanel,
      tabController: this.tabController,
    });

    // Setup verification queue callbacks
    this.verificationQueue.setOnProgress((params) => {
      this.verificationController.handleProgress(params.id, params.progress, params.details);
      this.updateStatusBar();
    });
    this.verificationQueue.setOnComplete((id, result) => {
      this.verificationController.handleComplete(id, result);
      // 検証完了後、確実にステータスバーを更新
      setTimeout(() => this.updateStatusBar(), 0);
    });
    this.verificationQueue.setOnError((id, error) => {
      this.verificationController.handleError(id, error);
      setTimeout(() => this.updateStatusBar(), 0);
    });
    this.verificationQueue.initialize();

    // Initialize FileController
    this.fileController = new FileController({
      fileProcessor: this.fileProcessor,
      tabManager: this.tabManager,
      uiState: this.uiState,
      verificationQueue: this.verificationQueue,
      sidebar: this.sidebar,
      statusBar: this.statusBar,
      generateId: () => this.generateId(),
      onScreenshotServiceUpdate: (service) => this.chartController.updateScreenshotService(service),
      onStatusBarUpdate: () => this.updateStatusBar(),
    });

    // Initialize FolderController
    this.folderController = new FolderController({
      fileProcessor: this.fileProcessor,
      tabManager: this.tabManager,
      verificationQueue: this.verificationQueue,
      sidebar: this.sidebar,
      tabBar: this.tabBar,
      statusBar: this.statusBar,
      generateId: () => this.generateId(),
      addFileToVerification: (filename, rawData, folderId, relativePath, screenshots, startTimestamp) => {
        this.fileController.addFileToVerification(filename, rawData, folderId, relativePath, screenshots, startTimestamp);
      },
      addPlaintextFile: (fileData, folderId) => this.fileController.addPlaintextFile(fileData, folderId),
      addImageFile: (fileData, folderId) => this.fileController.addImageFile(fileData, folderId),
      onScreenshotServiceUpdate: (service) => this.chartController.updateScreenshotService(service),
      onStatusBarUpdate: () => this.updateStatusBar(),
      onFileRemove: (id) => this.handleFileRemove(id),
    });

    // File input change handler
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.handleFilesSelected(this.fileInput.files);
        this.fileInput.value = '';
      }
    });

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

  private openFileDialog(): void {
    this.fileInput.click();
  }

  private async handleFilesSelected(files: FileList): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await this.fileController.processFile(file);
    }
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

  private updateStatusBar(): void {
    const fileCount = this.sidebar.getFileCount();
    this.statusBar.setFileCount(fileCount);

    // TabManagerの状態に基づいて検証中かどうかを判定
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

  private generateId(): string {
    return `verify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
