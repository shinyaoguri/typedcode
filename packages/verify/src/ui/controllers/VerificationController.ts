/**
 * VerificationController - 検証フローを管理するコントローラー
 */
import type { VerifyTabManager } from '../../state/VerifyTabManager';
import type { UIStateManager } from '../../state/UIStateManager';
import type { TabBar, TabStatus } from '../TabBar';
import type { Sidebar, FileStatus } from '../Sidebar';
import type { StatusBarUI } from '../StatusBarUI';
import type { ResultPanel } from '../ResultPanel';
import type { TabController } from './TabController';
import type { ProgressDetails, VerificationResult } from '../../types';

export interface VerificationControllerDependencies {
  tabManager: VerifyTabManager;
  uiState: UIStateManager;
  tabBar: TabBar;
  sidebar: Sidebar;
  statusBar: StatusBarUI;
  resultPanel: ResultPanel;
  tabController: TabController;
}

export class VerificationController {
  private deps: VerificationControllerDependencies;

  constructor(deps: VerificationControllerDependencies) {
    this.deps = deps;
  }

  /**
   * 検証進捗を処理
   */
  handleProgress(id: string, progress: number, details?: ProgressDetails): void {
    const tabState = this.deps.tabManager.getTab(id);

    // 既に完了しているタブへの進捗更新はスキップ（遅延メッセージ対策）
    if (tabState?.status === 'success' || tabState?.status === 'warning' || tabState?.status === 'error') {
      return;
    }

    const statusChanged = tabState?.status !== 'verifying';

    this.deps.tabManager.updateTab(id, { progress, status: 'verifying', progressDetails: details });

    // ステータスが変わった場合のみフル更新、そうでなければ進捗のみ更新（チカチカ防止）
    if (statusChanged) {
      this.deps.sidebar.updateFileStatus(id, 'verifying', progress);
    } else {
      this.deps.sidebar.updateFileProgress(id, progress);
    }

    // タブが開いている場合のみ更新
    if (this.deps.tabBar.hasTab(id)) {
      this.deps.tabBar.updateTabStatus(id, 'verifying', progress);
    }

    // アクティブタブの場合、詳細な進捗UIを更新
    if (this.deps.tabBar.getActiveTabId() === id && details) {
      this.deps.tabController.updateVerificationProgressUI(details, progress);
    }
  }

  /**
   * 検証完了を処理
   */
  handleComplete(id: string, result: VerificationResult): void {
    console.log('[DEBUG] handleVerificationComplete called', { id, chainValid: result.chainValid });

    // 現在のタブ状態を取得（ソースファイル不一致情報を確認するため）
    const currentTabState = this.deps.tabManager.getTab(id);
    const hasSourceMismatch = !!currentTabState?.associatedSourceMismatch;

    // ステータス判定: エラー > 警告（外部入力/ソース不一致） > 成功
    let status: FileStatus;
    if (!result.chainValid) {
      status = 'error';
    } else if (!result.isPureTyping || hasSourceMismatch) {
      status = 'warning';
    } else {
      status = 'success';
    }

    this.deps.uiState.incrementCompleted();
    const state = this.deps.uiState.getState();
    console.log('[DEBUG] completedCount:', state.completedCount, 'totalCount:', state.totalCount);

    this.deps.tabManager.updateTab(id, { verificationResult: result, status });
    console.log('[DEBUG] tabManager.updateTab done, new status:', status, 'hasSourceMismatch:', hasSourceMismatch);

    this.deps.sidebar.updateFileStatus(id, status);

    // タブが開いている場合のみ更新
    if (this.deps.tabBar.hasTab(id)) {
      this.deps.tabBar.updateTabStatus(id, status as TabStatus);
    }

    // アクティブタブの場合、結果を表示
    if (this.deps.tabBar.getActiveTabId() === id) {
      this.deps.resultPanel.finishProgress();
      // 強制更新フラグを渡して結果を確実に表示
      this.deps.tabController.showTabContent(id, true);
    }
  }

  /**
   * 検証エラーを処理
   */
  handleError(id: string, error: string): void {
    this.deps.uiState.incrementCompleted();
    this.deps.tabManager.updateTab(id, { status: 'error', error });
    this.deps.sidebar.updateFileStatus(id, 'error');
    // タブが開いている場合のみ更新
    if (this.deps.tabBar.hasTab(id)) {
      this.deps.tabBar.updateTabStatus(id, 'error');
    }

    if (this.deps.tabBar.getActiveTabId() === id) {
      // 進捗UIをエラー状態に
      this.deps.resultPanel.errorProgress('chain', error);
      this.deps.statusBar.setError(error);
    }
  }
}
