/**
 * TabController - タブ操作を管理するコントローラー
 */
import type { VerifyTabManager } from '../../state/VerifyTabManager';
import type { UIStateManager } from '../../state/UIStateManager';
import type { TabBar, TabStatus } from '../TabBar';
import type { Sidebar } from '../Sidebar';
import type { ResultPanel } from '../ResultPanel';
import type { WelcomePanel } from '../WelcomePanel';
import type { TimelineChart } from '../../charts/TimelineChart';
import type { MouseChart } from '../../charts/MouseChart';
import type { IntegratedChart } from '../../charts/IntegratedChart';
import type { ScreenshotOverlay } from '../../charts/ScreenshotOverlay';
import type { ScreenshotLightbox } from '../ScreenshotLightbox';
import type { SeekbarController } from '../../charts/SeekbarController';
import type { VerifyTabState, ProgressDetails, VerifyScreenshot, ScreenshotVerificationSummary, VerificationStepType } from '../../types';
import { buildResultData, calculateChartStats } from '../../services/ResultDataService';
import { TrustCalculator } from '../../services/TrustCalculator';

export interface TabControllerDependencies {
  tabManager: VerifyTabManager;
  uiState: UIStateManager;
  tabBar: TabBar;
  sidebar: Sidebar;
  resultPanel: ResultPanel;
  welcomePanel: WelcomePanel;
  getTimelineChart: () => TimelineChart | null;
  getMouseChart: () => MouseChart | null;
  // IntegratedChart関連（オプショナル - 後方互換性のため）
  getIntegratedChart?: () => IntegratedChart | null;
  getScreenshotOverlay?: () => ScreenshotOverlay | null;
  getScreenshotLightbox?: () => ScreenshotLightbox | null;
  getSeekbarController?: () => SeekbarController | null;
}

export class TabController {
  private deps: TabControllerDependencies;

  constructor(deps: TabControllerDependencies) {
    this.deps = deps;
  }

  /**
   * ファイルIDに対応するタブを開く（または既存タブを選択）
   */
  openTabForFile(id: string): void {
    const tabState = this.deps.tabManager.getTab(id);
    if (!tabState) return;

    // タブバーにタブがなければ追加
    if (!this.deps.tabBar.hasTab(id)) {
      this.deps.tabBar.addTab({
        id,
        filename: tabState.filename,
        status: tabState.status,
        progress: tabState.progress,
      });
    }

    // タブを選択
    this.deps.tabBar.setActiveTab(id);
    this.deps.sidebar.setActiveFile(id);

    // Hide welcome panel, show result container
    this.deps.welcomePanel.hide();
    this.deps.resultPanel.show();

    // コンテンツを表示
    this.showTabContent(id);
  }

  /**
   * ファイル一覧から選択時のハンドラー
   */
  handleFileSelect(id: string): void {
    this.openTabForFile(id);
  }

  /**
   * タブ選択時のハンドラー
   */
  handleTabSelect(id: string): void {
    this.deps.sidebar.setActiveFile(id);
    this.showTabContent(id);
  }

  /**
   * タブ切り替え時のハンドラー（内部用）
   */
  handleTabSwitch(id: string): void {
    this.showTabContent(id);
  }

  /**
   * タブを閉じる時のハンドラー
   */
  handleTabClose(id: string): void {
    // 閉じるタブが表示中の場合、表示状態をリセット
    if (this.deps.uiState.isDisplayed(id)) {
      this.deps.uiState.setCurrentDisplayedTabId(null);
    }

    // タブを閉じてもサイドバーのファイル一覧には残す
    this.deps.tabBar.removeTab(id);

    // タブがなくなった場合、ウェルカムパネルを表示
    // （ただしサイドバーにはファイルが残っている）
    if (!this.deps.tabBar.getActiveTabId()) {
      this.deps.resultPanel.hide();
      this.deps.welcomePanel.show();
    }
  }

  /**
   * タブのコンテンツを表示
   */
  showTabContent(id: string, forceRefresh: boolean = false): void {
    const tabState = this.deps.tabManager.getTab(id);
    if (!tabState) return;

    // 同じタブで、強制更新でなければスキップ（チカチカ防止）
    const isSameTab = this.deps.uiState.isDisplayed(id);

    console.log('[DEBUG] showTabContent:', {
      id,
      forceRefresh,
      isSameTab,
      status: tabState.status,
      hasVerificationResult: !!tabState.verificationResult,
      hasProofData: !!tabState.proofData,
      isPlaintext: tabState.isPlaintext,
      isImage: tabState.isImage,
    });

    // プレーンテキストファイルの場合
    if (tabState.isPlaintext) {
      if (!isSameTab || forceRefresh) {
        this.deps.uiState.setCurrentDisplayedTabId(id);
        this.deps.resultPanel.renderPlaintext({
          filename: tabState.filename,
          content: tabState.plaintextContent || '',
          language: tabState.language,
          diffResult: tabState.diffResult,
          hasContentMismatch: tabState.hasContentMismatch,
        });
      }
      return;
    }

    // 画像ファイルの場合
    if (tabState.isImage) {
      if (!isSameTab || forceRefresh) {
        this.deps.uiState.setCurrentDisplayedTabId(id);
        this.deps.resultPanel.renderImage({
          filename: tabState.filename,
          imageBlob: tabState.imageBlob,
        });
      }
      return;
    }

    if (tabState.status === 'verifying' || tabState.status === 'pending') {
      // 検証中/待機中の場合
      if (!isSameTab) {
        // 新しいタブの場合のみstartProgressを呼ぶ
        this.deps.uiState.setCurrentDisplayedTabId(id);
        this.deps.resultPanel.startProgress(tabState.filename);
      }
      // 既存の進捗があれば反映（同じタブでも更新）
      if (tabState.progressDetails) {
        this.updateVerificationProgressUI(tabState.progressDetails, tabState.progress);
      }
    } else if (tabState.verificationResult && tabState.proofData) {
      // 完了している場合
      if (!isSameTab || forceRefresh) {
        this.deps.uiState.setCurrentDisplayedTabId(id);
        this.deps.resultPanel.stopProgressTimer();
        this.renderResult(tabState);
      }
    }
  }

  /**
   * 検証進捗UIを更新
   */
  updateVerificationProgressUI(details: ProgressDetails, overallProgress: number): void {
    const { phase, current, total, totalEvents } = details;

    // 全体進捗を更新
    this.deps.resultPanel.updateOverallProgress(overallProgress);

    // フェーズに応じてステップを更新
    if (phase === 'metadata' || phase === 'init') {
      // メタデータ検証中
      this.deps.resultPanel.updateStepStatus('metadata', 'running');
      this.deps.resultPanel.updateStepProgress('metadata', (current / total) * 100);
    } else if (phase === 'chain' || phase === 'full' || phase === 'fallback') {
      // 全件検証（チェックポイントなしでフォールバック）
      this.deps.resultPanel.updateStepStatus('metadata', 'success');
      this.deps.resultPanel.updateStepProgress('metadata', 100); // メタデータ完了
      // フォールバック時のみchainステップを表示
      this.deps.resultPanel.showFallbackStep();
      this.deps.resultPanel.updateStepStatus('chain', 'running', 'フォールバック');
      // サンプリングはスキップ（チェックポイントなしのため）
      this.deps.resultPanel.updateStepStatus('sampling', 'skipped', 'チェックポイントなし');

      const chainProgress = (current / total) * 100;
      const detail = `${current.toLocaleString()} / ${total.toLocaleString()} イベント`;
      this.deps.resultPanel.updateStepProgress('chain', chainProgress, detail);
    } else if (phase === 'segment' || phase === 'checkpoint') {
      // サンプリング検証（チェックポイントあり）
      this.deps.resultPanel.updateStepStatus('metadata', 'success');
      this.deps.resultPanel.updateStepProgress('metadata', 100); // メタデータ完了
      // チェックポイントありの場合、chainステップは非表示のまま
      this.deps.resultPanel.updateStepStatus('sampling', 'running');

      const samplingProgress = (current / total) * 100;
      // 検証済み / 対象イベント数 (全イベント数) の形式で表示
      const totalEventsStr = totalEvents ? ` (全${totalEvents.toLocaleString()}イベント)` : '';
      const detail = `${current.toLocaleString()}イベント検証済み / ${total.toLocaleString()}イベント${totalEventsStr}`;
      this.deps.resultPanel.updateStepProgress('sampling', samplingProgress, detail);
    } else if (phase === 'complete') {
      // 全完了
      this.deps.resultPanel.updateStepStatus('metadata', 'success');
      this.deps.resultPanel.updateStepProgress('metadata', 100); // メタデータ完了
      // チェーンとサンプリングの最終状態を確認して更新
      const chainEl = document.getElementById('vp-step-chain');
      const samplingEl = document.getElementById('vp-step-sampling');
      // chainが表示されている（フォールバック）場合のみ成功に
      if (chainEl && chainEl.style.display !== 'none') {
        this.deps.resultPanel.updateStepStatus('chain', 'success');
        this.deps.resultPanel.updateStepProgress('chain', 100);
      }
      if (samplingEl?.dataset.status !== 'skipped') {
        this.deps.resultPanel.updateStepStatus('sampling', 'success');
        this.deps.resultPanel.updateStepProgress('sampling', 100);
      }
      this.deps.resultPanel.finishProgress();
    }
  }

  /**
   * 結果をレンダリング
   */
  private renderResult(tabState: VerifyTabState): void {
    console.log('[TabController] renderResult:', {
      filename: tabState.filename,
      screenshotsCount: tabState.screenshots?.length ?? 0,
      screenshotsDetails: tabState.screenshots?.map((s) => ({
        id: s.id,
        verified: s.verified,
        missing: s.missing,
        tampered: s.tampered,
      })),
      startTimestamp: tabState.startTimestamp,
      associatedSourceMismatch: tabState.associatedSourceMismatch,
    });

    // スクリーンショット検証サマリーを計算
    const screenshotSummary = this.calculateScreenshotSummary(tabState.screenshots);

    // ソースファイル不一致情報を準備（proofファイルに関連付けられたソースファイルの不一致）
    const contentMismatches = tabState.associatedSourceMismatch
      ? [tabState.associatedSourceMismatch]
      : undefined;

    // 信頼度を計算
    const trustResult = TrustCalculator.calculate(
      tabState.verificationResult,
      tabState.humanAttestationResult,
      screenshotSummary,
      contentMismatches
    );

    console.log('[TabController] Trust result:', trustResult);

    const resultData = buildResultData(tabState);
    if (!resultData) return;

    // trustResult を追加してレンダリング
    this.deps.resultPanel.render({ ...resultData, trustResult });

    // スクリーンショット検証結果を表示
    if (tabState.screenshots && tabState.screenshots.length > 0) {
      this.deps.resultPanel.updateScreenshotVerification({
        total: screenshotSummary.total,
        verified: screenshotSummary.verified,
        missing: screenshotSummary.missing,
      });
    }

    // Render charts
    const events = tabState.proofData?.proof?.events;
    if (events && events.length > 0) {
      this.renderCharts(events, tabState.screenshots, tabState.startTimestamp);
    }
  }

  /**
   * チャートをレンダリング
   */
  private renderCharts(events: any[], screenshots?: VerifyScreenshot[], startTimestamp?: number): void {
    const timelineChart = this.deps.getTimelineChart();
    const mouseChart = this.deps.getMouseChart();
    const integratedChart = this.deps.getIntegratedChart?.();
    const screenshotLightbox = this.deps.getScreenshotLightbox?.();
    const seekbarController = this.deps.getSeekbarController?.();

    // IntegratedChartが利用可能な場合はそれを使用
    if (integratedChart) {
      integratedChart.draw(events, screenshots ?? [], { startTimestamp });

      // スクリーンショット一覧をライトボックスに設定
      if (screenshotLightbox && screenshots && screenshots.length > 0) {
        screenshotLightbox.setScreenshots(screenshots);
      }

      // SeekbarControllerにIntegratedChartを連携し、イベントで初期化
      if (seekbarController) {
        seekbarController.setIntegratedChart(integratedChart);
        // アクティブなタブのコンテンツを取得してシークバーを初期化
        const activeTabId = this.deps.tabBar.getActiveTabId();
        if (activeTabId) {
          const tabState = this.deps.tabManager.getTab(activeTabId);
          if (tabState?.proofData?.content) {
            seekbarController.initialize(events, tabState.proofData.content);
          }
        }
      }
    }

    // TimelineChartとMouseChartは常に描画（別キャンバスのため）
    if (timelineChart) {
      timelineChart.draw(events, events);
    }

    if (mouseChart) {
      mouseChart.draw(events, events);
    }

    // Update chart stats
    const stats = calculateChartStats(events);
    this.deps.resultPanel.updateChartStats(stats);
  }

  /**
   * タブステータスを更新（タブが開いている場合のみ）
   */
  updateTabStatusIfOpen(id: string, status: TabStatus, progress?: number): void {
    if (this.deps.tabBar.hasTab(id)) {
      this.deps.tabBar.updateTabStatus(id, status, progress);
    }
  }

  /**
   * アクティブなタブIDを取得
   */
  getActiveTabId(): string | null {
    return this.deps.tabBar.getActiveTabId();
  }

  /**
   * 進捗を終了（アクティブタブの場合）
   */
  finishProgressIfActive(id: string): void {
    if (this.deps.tabBar.getActiveTabId() === id) {
      this.deps.resultPanel.finishProgress();
    }
  }

  /**
   * エラー進捗を表示（アクティブタブの場合）
   */
  errorProgressIfActive(id: string, step: VerificationStepType, error: string): void {
    if (this.deps.tabBar.getActiveTabId() === id) {
      this.deps.resultPanel.errorProgress(step, error);
    }
  }

  /**
   * スクリーンショット検証サマリーを計算
   */
  private calculateScreenshotSummary(screenshots?: VerifyScreenshot[]): ScreenshotVerificationSummary {
    if (!screenshots || screenshots.length === 0) {
      return TrustCalculator.emptyScreenshotSummary();
    }

    return {
      total: screenshots.length,
      verified: screenshots.filter((s) => s.verified && !s.missing && !s.tampered).length,
      missing: screenshots.filter((s) => s.missing).length,
      tampered: screenshots.filter((s) => s.tampered).length,
    };
  }
}
