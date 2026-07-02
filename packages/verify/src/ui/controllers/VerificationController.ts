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
import type { ProgressDetails, VerificationResultData } from '../../types';
import { t } from '../../i18n/index';

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
  handleComplete(id: string, result: VerificationResultData): void {
    // 現在のタブ状態を取得（ソースファイル不一致情報を確認するため）
    const currentTabState = this.deps.tabManager.getTab(id);
    const hasSourceMismatch = !!currentTabState?.associatedSourceMismatch;

    // スクリーンショット検証 (#146): enqueue 時に tabState へ保持済みの per-image 判定を集計。
    // TrustCalculator (改竄 = error) / deriveAssurance (integrity failed) と同じ軸を見る —
    // ここだけ見ないとサイドバー/タブの緑と開いた結果バッジが食い違い、緑の流し見で
    // 改竄提出が素通りする (verify/CLAUDE.md「両者を揃えて変更すること」)。
    const screenshots = currentTabState?.screenshots ?? [];
    const screenshotsTampered = screenshots.filter((s) => s.tampered).length;
    const screenshotsMissing = screenshots.filter((s) => s.missing).length;
    // 画面共有オプトアウト (TrustCalculator と同じく warning 軸)
    const events = currentTabState?.proofData?.proof?.events ?? [];
    const hasScreenShareOptOut = events.some(
      (e: { type: string }) => e.type === 'screenShareOptOut'
    );

    // ステータス判定: エラー > 警告 > 成功。
    // - error: チェーン/メタデータ破綻、署名 cp があるのに無効、package 提供下で exam 束縛失敗 (spec §6.4)、
    //          スクショ改竄 (#146)
    // - warning: 非ピュアタイピング / ソース不一致 / 時刻アンカー無し (偽造不能要素が無い) /
    //            post-hoc 一括署名疑い / anchoring 密度が疎 (ADR-0016) / exam だが問題パッケージ未検証 (真正性未確認) /
    //            スクショ欠損 / 画面共有オプトアウト (#146)
    const examBindingFailed =
      !!result.exam?.packageProvided && result.exam.binding?.valid === false;
    const anchoredButInvalid =
      !!result.signedCheckpointAnchored && result.signedCheckpointValid === false;
    const examPresentButUnverified =
      !!result.exam?.present && !result.exam.packageProvided;
    // ADR-0017: root 未アンカー (serverNonce トークン無し) は警告。exam は独自束縛のため対象外。
    const rootNotAnchored = !result.rootAnchored && !result.exam?.present;
    let status: FileStatus;
    if (
      !result.metadataValid ||
      !result.chainValid ||
      examBindingFailed ||
      anchoredButInvalid ||
      screenshotsTampered > 0
    ) {
      status = 'error';
    } else if (
      !result.isPureTyping ||
      hasSourceMismatch ||
      !result.signedCheckpointAnchored ||
      result.signedCheckpointTemporal?.postHocSuspected ||
      result.signedCheckpointDensity?.sparse ||
      rootNotAnchored ||
      examPresentButUnverified ||
      screenshotsMissing > 0 ||
      hasScreenShareOptOut
    ) {
      status = 'warning';
    } else {
      status = 'success';
    }

    this.deps.uiState.incrementCompleted();

    this.deps.tabManager.updateTab(id, { verificationResult: result, status });

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
    } else if (this.deps.tabBar.getActiveTabId() === null) {
      // まだ何も開いていなければ最初に完了した proof を自動で開く。
      // 以降は別タブがアクティブになるのでフォーカスを奪わない (UX: 読込直後の空白を解消)。
      this.deps.tabController.openTabForFile(id);
    }
  }

  /**
   * 検証エラーを処理
   */
  handleError(id: string, rawError: string): void {
    // Worker はロケール設定 (localStorage) にアクセスできないため翻訳キーを
    // そのまま送ってくることがある。ここでメインスレッドのロケールで解決する
    // (t() は未知のキーをそのまま返すので通常のエラーメッセージには無害)。
    const error = rawError.startsWith('errors.') ? t(rawError) : rawError;
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
