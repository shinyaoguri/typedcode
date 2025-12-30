/**
 * AppController - Main orchestration for the Verify application
 */
import { ThemeManager } from './ThemeManager';
import { ActivityBar } from './ActivityBar';
import { Sidebar, type FileStatus } from './Sidebar';
import { TabBar, type TabStatus } from './TabBar';
import { StatusBarUI } from './StatusBarUI';
import { WelcomePanel } from './WelcomePanel';
import { ResultPanel, type ResultData } from './ResultPanel';
import { VerifyTabManager } from '../state/VerifyTabManager';
import { VerificationQueue } from '../state/VerificationQueue';
import { FileProcessor, type ParsedFileData } from '../services/FileProcessor';
import { FileSystemAccessService } from '../services/FileSystemAccessService';
import { FolderSyncManager } from '../services/FolderSyncManager';
import { TimelineChart } from '../charts/TimelineChart';
import { MouseChart } from '../charts/MouseChart';
import type {
  ProofFile,
  VerificationResult,
  PoswStats,
  HumanAttestationUI,
  VerifyTabState,
  FSAccessFileEntry,
  HierarchicalFolder,
  ProgressDetails,
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

  // File System Access API
  private fsAccessService: FileSystemAccessService;
  private syncManager: FolderSyncManager;
  private watchedRootHandle: FileSystemDirectoryHandle | null = null;
  private watchedRootFolderId: string | null = null;

  private timelineChart: TimelineChart | null = null;
  private mouseChart: MouseChart | null = null;

  private fileInput: HTMLInputElement;
  private completedCount = 0;
  private totalCount = 0;

  // ファイル名の重複カウント（表示名の区別用）
  private filenameCounter: Map<string, number> = new Map();

  // 現在ResultPanelに表示中のタブID（不要な再描画防止）
  private currentDisplayedTabId: string | null = null;

  constructor() {
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;

    // Initialize theme
    this.themeManager = new ThemeManager();

    // Initialize File System Access API
    this.fsAccessService = new FileSystemAccessService({
      onPermissionDenied: (error) => {
        this.statusBar.setError(`アクセス拒否: ${error.message}`);
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

    if (timelineCanvas) {
      this.timelineChart = new TimelineChart({ canvas: timelineCanvas });
    }

    if (mouseCanvas) {
      this.mouseChart = new MouseChart({ canvas: mouseCanvas });
    }
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
        this.statusBar.setError(result.error || 'ファイル読み込みエラー');
        return;
      }

      // ZIPファイルの場合はフォルダを作成
      let folderId: string | undefined;
      if (file.name.endsWith('.zip')) {
        folderId = this.createFolderForZip(file.name);
      }

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          this.addFileToVerification(fileData.filename, fileData.rawData, folderId);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }
    } catch (error) {
      console.error('Error processing file:', error);
      this.statusBar.setError(`ファイル読み込みエラー: ${file.name}`);
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
    // 重複カウントを更新
    const key = `folder:${baseName}`;
    const count = this.filenameCounter.get(key) || 0;
    this.filenameCounter.set(key, count + 1);

    // 2つ目以降は番号を付ける
    if (count > 0) {
      return `${baseName} (${count + 1})`;
    }
    return baseName;
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

    // 最初のファイルの場合は自動的にタブを開く
    const isFirstFile = this.sidebar.getFileCount() === 1;
    if (isFirstFile) {
      this.openTabForFile(id);
    }

    this.updateStatusBar();
  }

  private addFileToVerification(filename: string, rawData: string, folderId?: string, relativePath?: string): void {
    try {
      const proofData = JSON.parse(rawData) as ProofFile;
      const id = this.generateId();

      // 表示名を生成（重複がある場合は番号を付ける）
      const displayName = this.generateDisplayName(filename, folderId);

      // Add to tab manager (state management)
      this.tabManager.addTab({
        id,
        filename: displayName,
        language: proofData.language || 'unknown',
        status: 'pending',
        progress: 0,
        proofData,
        verificationResult: null,
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
      // ただし最初のファイルは自動的にタブを開く
      const isFirstFile = this.sidebar.getFileCount() === 1;
      if (isFirstFile) {
        this.openTabForFile(id);
      }

      // Track counts
      this.totalCount++;

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
    const tabState = this.tabManager.getTab(id);
    if (!tabState) return;

    // タブバーにタブがなければ追加
    if (!this.tabBar.hasTab(id)) {
      this.tabBar.addTab({
        id,
        filename: tabState.filename,
        status: tabState.status,
        progress: tabState.progress,
      });
    }

    // タブを選択
    this.tabBar.setActiveTab(id);
    this.sidebar.setActiveFile(id);

    // Hide welcome panel, show result container
    this.welcomePanel.hide();
    this.resultPanel.show();

    // コンテンツを表示
    this.showTabContent(id);
  }

  private handleFileSelect(id: string): void {
    // ファイル一覧から選択時、タブを開く（または既存タブを選択）
    this.openTabForFile(id);
  }

  private handleTabSelect(id: string): void {
    this.sidebar.setActiveFile(id);
    this.showTabContent(id);
  }

  private handleTabSwitch(id: string): void {
    this.showTabContent(id);
  }

  private handleTabClose(id: string): void {
    // 閉じるタブが表示中の場合、表示状態をリセット
    if (this.currentDisplayedTabId === id) {
      this.currentDisplayedTabId = null;
    }

    // タブを閉じてもサイドバーのファイル一覧には残す
    this.tabBar.removeTab(id);

    // タブがなくなった場合、ウェルカムパネルを表示
    // （ただしサイドバーにはファイルが残っている）
    if (!this.tabBar.getActiveTabId()) {
      this.resultPanel.hide();
      this.welcomePanel.show();
    }

    this.updateStatusBar();
  }

  private handleFileRemove(id: string): void {
    // 削除するファイルが表示中の場合、表示状態をリセット
    if (this.currentDisplayedTabId === id) {
      this.currentDisplayedTabId = null;
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
      if (this.currentDisplayedTabId === fileId) {
        this.currentDisplayedTabId = null;
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
    const tabState = this.tabManager.getTab(id);
    if (!tabState) return;

    // 同じタブで、強制更新でなければスキップ（チカチカ防止）
    const isSameTab = this.currentDisplayedTabId === id;

    // プレーンテキストファイルの場合
    if (tabState.isPlaintext) {
      if (!isSameTab || forceRefresh) {
        this.currentDisplayedTabId = id;
        this.resultPanel.renderPlaintext({
          filename: tabState.filename,
          content: tabState.plaintextContent || '',
          language: tabState.language,
        });
      }
      return;
    }

    if (tabState.status === 'verifying' || tabState.status === 'pending') {
      // 検証中/待機中の場合
      if (!isSameTab) {
        // 新しいタブの場合のみstartProgressを呼ぶ
        this.currentDisplayedTabId = id;
        this.resultPanel.startProgress(tabState.filename);
      }
      // 既存の進捗があれば反映（同じタブでも更新）
      if (tabState.progressDetails) {
        this.updateVerificationProgressUI(tabState.progressDetails, tabState.progress);
      }
    } else if (tabState.verificationResult && tabState.proofData) {
      // 完了している場合
      if (!isSameTab || forceRefresh) {
        this.currentDisplayedTabId = id;
        this.resultPanel.stopProgressTimer();
        this.renderResult(tabState);
      }
    }
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
      this.updateVerificationProgressUI(details, progress);
    }

    this.updateStatusBar();
  }

  /**
   * 検証進捗UIを更新
   */
  private updateVerificationProgressUI(details: ProgressDetails, overallProgress: number): void {
    const { phase, current, total, totalEvents } = details;

    // 全体進捗を更新
    this.resultPanel.updateOverallProgress(overallProgress);

    // フェーズに応じてステップを更新
    if (phase === 'metadata' || phase === 'init') {
      // メタデータ検証中
      this.resultPanel.updateStepStatus('metadata', 'running');
      this.resultPanel.updateStepProgress('metadata', (current / total) * 100);
    } else if (phase === 'chain' || phase === 'full' || phase === 'fallback') {
      // 全件検証（チェックポイントなしでフォールバック）
      this.resultPanel.updateStepStatus('metadata', 'success');
      // フォールバック時のみchainステップを表示
      this.resultPanel.showFallbackStep();
      this.resultPanel.updateStepStatus('chain', 'running', 'フォールバック');
      // サンプリングはスキップ（チェックポイントなしのため）
      this.resultPanel.updateStepStatus('sampling', 'skipped', 'チェックポイントなし');

      const chainProgress = (current / total) * 100;
      const detail = `${current.toLocaleString()} / ${total.toLocaleString()} イベント`;
      this.resultPanel.updateStepProgress('chain', chainProgress, detail);
    } else if (phase === 'segment' || phase === 'checkpoint') {
      // サンプリング検証（チェックポイントあり）
      this.resultPanel.updateStepStatus('metadata', 'success');
      // チェックポイントありの場合、chainステップは非表示のまま
      this.resultPanel.updateStepStatus('sampling', 'running');

      const samplingProgress = (current / total) * 100;
      // 検証済み / 対象イベント数 (全イベント数) の形式で表示
      const totalEventsStr = totalEvents ? ` (全${totalEvents.toLocaleString()}イベント)` : '';
      const detail = `${current.toLocaleString()}イベント検証済み / ${total.toLocaleString()}イベント${totalEventsStr}`;
      this.resultPanel.updateStepProgress('sampling', samplingProgress, detail);
    } else if (phase === 'complete') {
      // 全完了
      this.resultPanel.updateStepStatus('metadata', 'success');
      // チェーンとサンプリングの最終状態を確認して更新
      const chainEl = document.getElementById('vp-step-chain');
      const samplingEl = document.getElementById('vp-step-sampling');
      // chainが表示されている（フォールバック）場合のみ成功に
      if (chainEl && chainEl.style.display !== 'none') {
        this.resultPanel.updateStepStatus('chain', 'success');
      }
      if (samplingEl?.dataset.status !== 'skipped') {
        this.resultPanel.updateStepStatus('sampling', 'success');
      }
      this.resultPanel.finishProgress();
    }
  }

  private handleVerificationComplete(id: string, result: any): void {
    console.log('[DEBUG] handleVerificationComplete called', { id, chainValid: result.chainValid });

    const status: FileStatus = result.chainValid
      ? result.isPureTyping
        ? 'success'
        : 'warning'
      : 'error';

    this.completedCount++;
    console.log('[DEBUG] completedCount:', this.completedCount, 'totalCount:', this.totalCount);

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
    this.completedCount++;
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

  private renderResult(tabState: VerifyTabState): void {
    if (!tabState.proofData || !tabState.verificationResult) return;

    const { proofData, verificationResult } = tabState;
    const events = proofData.proof?.events;

    // Calculate stats
    const eventCount = events?.length || 0;
    const typingTime = this.formatTypingTime(events);
    const typingSpeed = this.calculateTypingSpeed(proofData, events);

    // Convert result format
    const result: VerificationResult = {
      chainValid: verificationResult.chainValid,
      pureTyping: verificationResult.isPureTyping,
      pasteCount: this.countPasteEvents(proofData),
      verificationMethod: verificationResult.sampledResult ? 'sampled' : 'full',
    };

    // Convert PoSW stats
    const poswStats: PoswStats | undefined = verificationResult.poswStats
      ? {
          totalIterations: verificationResult.poswStats.iterations,
          totalTime: verificationResult.poswStats.totalTimeMs,
          avgTime: verificationResult.poswStats.avgTimeMs,
        }
      : undefined;

    // Convert attestations
    const attestations: HumanAttestationUI[] = [];
    if (tabState.humanAttestationResult?.hasAttestation) {
      if (tabState.humanAttestationResult.createValid !== undefined) {
        attestations.push({
          type: 'create',
          eventIndex: 0,
          valid: tabState.humanAttestationResult.createValid,
        });
      }
      if (tabState.humanAttestationResult.exportValid !== undefined) {
        attestations.push({
          type: 'export',
          valid: tabState.humanAttestationResult.exportValid,
        });
      }
    }

    const resultData: ResultData = {
      filename: tabState.filename,
      content: proofData.content || '',
      language: tabState.language,
      result,
      poswStats,
      attestations: attestations.length > 0 ? attestations : undefined,
      eventCount,
      typingTime,
      typingSpeed,
    };

    this.resultPanel.render(resultData);

    // Render charts
    if (events && events.length > 0) {
      this.renderCharts(events);
    }
  }

  private renderCharts(events: any[]): void {
    if (this.timelineChart) {
      this.timelineChart.draw(events, events);
    }

    if (this.mouseChart) {
      this.mouseChart.draw(events, events);
    }

    // Update chart stats
    const stats = this.calculateChartStats(events);
    this.resultPanel.updateChartStats(stats);
  }

  private calculateChartStats(events: any[]): {
    keydownCount: number;
    avgDwellTime: number;
    avgFlightTime: number;
    mouseEventCount: number;
  } {
    let keydownCount = 0;
    let mouseEventCount = 0;
    const dwellTimes: number[] = [];
    const flightTimes: number[] = [];
    let lastKeyUpTime = 0;

    for (const event of events) {
      if (event.type === 'keydown') {
        keydownCount++;
        if (lastKeyUpTime > 0) {
          flightTimes.push(event.timestamp - lastKeyUpTime);
        }
      } else if (event.type === 'keyup') {
        lastKeyUpTime = event.timestamp;
      } else if (event.type === 'mousePositionChange') {
        mouseEventCount++;
      }
    }

    return {
      keydownCount,
      avgDwellTime: dwellTimes.length > 0 ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length : 0,
      avgFlightTime: flightTimes.length > 0 ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length : 0,
      mouseEventCount,
    };
  }

  private formatTypingTime(events?: any[]): string {
    if (!events || events.length < 2) return '-';

    const firstTime = events[0].timestamp;
    const lastTime = events[events.length - 1].timestamp;
    const totalMs = lastTime - firstTime;

    const seconds = Math.floor(totalMs / 1000) % 60;
    const minutes = Math.floor(totalMs / 60000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private calculateTypingSpeed(proofData: ProofFile, events?: any[]): string {
    if (!events || events.length < 2) return '-';

    const contentLength = proofData.content?.length || 0;
    const firstTime = events[0].timestamp;
    const lastTime = events[events.length - 1].timestamp;
    const minutes = (lastTime - firstTime) / 60000;

    if (minutes <= 0) return '-';

    const cpm = Math.round(contentLength / minutes);
    return `${cpm} CPM`;
  }

  private countPasteEvents(proofData: ProofFile): number {
    const events = proofData.proof?.events;
    if (!events) return 0;

    return events.filter(
      (e: any) => e.type === 'contentChange' && e.inputType === 'paste'
    ).length;
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
      this.statusBar.setVerifying(this.completedCount, this.totalCount);
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
      this.statusBar.setError(result.error ?? 'フォルダ読み取りエラー');
      return;
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

    // サブフォルダを追加
    const folderMap = new Map<string, string>(); // path -> folderId
    folderMap.set('', rootFolderId);

    // フォルダをソートしてから追加（親フォルダが先に処理されるように）
    const sortedFolders = result.folders.sort((a, b) => a.path.localeCompare(b.path));

    for (const folder of sortedFolders) {
      const folderId = this.generateId();
      const parentPath = folder.path.split('/').slice(0, -1).join('/');
      const parentId = folderMap.get(parentPath) ?? rootFolderId;
      const depth = folder.path.split('/').length;

      const hierarchicalFolder: HierarchicalFolder = {
        id: folderId,
        name: folder.name,
        path: folder.path,
        parentId,
        expanded: depth <= 1, // 1階層目まで展開
        depth,
        sourceType: 'fsaccess',
        directoryHandle: folder.handle,
      };

      this.sidebar.addHierarchicalFolder(hierarchicalFolder);
      folderMap.set(folder.path, folderId);
    }

    // ファイルを処理
    for (const fileEntry of result.files) {
      await this.processFileFromHandle(fileEntry, folderMap);
    }

    // 監視を開始
    this.watchedRootHandle = handle;
    await this.syncManager.startWatching(handle, 3000);

    this.updateStatusBar();
    this.statusBar.setMessage(`フォルダを開きました: ${result.rootName}`);
  }

  /**
   * FileSystemFileHandle からファイルを処理
   */
  private async processFileFromHandle(
    fileEntry: FSAccessFileEntry,
    folderMap: Map<string, string>
  ): Promise<void> {
    const parentPath = fileEntry.path.split('/').slice(0, -1).join('/');
    const folderId = folderMap.get(parentPath);

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
          this.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath);
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

      this.statusBar.setMessage(`ファイル追加: ${file.name}`);
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

      this.statusBar.setMessage(`ファイル更新: ${file.name}`);
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
      this.statusBar.setMessage(`ファイル削除: ${filename}`);
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
    this.statusBar.setMessage(`フォルダ追加: ${name}`);
  }

  /**
   * 外部でフォルダが削除された時の処理
   */
  private handleExternalFolderDeleted(path: string): void {
    this.sidebar.removeFolderByPath(path);
    const folderName = path.split('/').pop() ?? path;
    this.statusBar.setMessage(`フォルダ削除: ${folderName}`);
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
          <h3>ブラウザがサポートされていません</h3>
        </div>
        <div class="modal-body">
          <p>File System Access API は Chrome / Edge でのみ利用可能です。</p>
          <p>代わりにファイル選択またはドラッグ＆ドロップをご利用ください。</p>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()">
            閉じる
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
    // フォルダ内のファイルはフォルダIDを含めたキーで重複チェック
    const key = folderId ? `${folderId}:${filename}` : filename;

    // 重複カウントを更新
    const count = this.filenameCounter.get(key) || 0;
    this.filenameCounter.set(key, count + 1);

    // 2つ目以降は番号を付ける
    if (count > 0) {
      const ext = filename.match(/\.[^.]+$/)?.[0] || '';
      const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
      return `${nameWithoutExt} (${count + 1})${ext}`;
    }

    return filename;
  }
}
