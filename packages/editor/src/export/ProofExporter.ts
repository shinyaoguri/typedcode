/**
 * ProofExporter - 証明データのエクスポート機能
 * 単一タブおよび複数タブのエクスポートを管理
 */

import JSZip from 'jszip';
import type { TabManager, TabState } from '../ui/tabs/TabManager.js';
import type { EditorMode } from '../core/mode.js';
import type { ProcessingDialog } from '../ui/components/ProcessingDialog.js';
import { ExportProgressDialog } from '../ui/components/ExportProgressDialog.js';
import type { ScreenshotTracker } from '../tracking/ScreenshotTracker.js';
import {
  isTurnstileConfigured,
  performTurnstileVerification,
  loadTurnstileScript,
} from '../services/TurnstileService.js';
import { getLanguageDefinition } from '../config/SupportedLanguages.js';
import { t } from '../i18n/index.js';
import { generateReadmeEn } from './readme-template-en.js';
import { generateReadmeJa } from './readme-template-ja.js';
import { summarizeProcess } from '@typedcode/shared';
import { SelfReviewDialog } from '../ui/components/SelfReviewDialog.js';

export interface ExportCallbacks {
  onNotification?: (message: string) => void;
}

export class ProofExporter {
  private tabManager: TabManager | null = null;
  private processingDialog: ProcessingDialog | null = null;
  private exportProgressDialog: ExportProgressDialog;
  private screenshotTracker: ScreenshotTracker | null = null;
  private callbacks: ExportCallbacks = {};
  /** エクスポート前認証を best-effort 化するか (ADR-0006/0011: `capabilities.preExportBestEffort`)。
   *  true のとき Turnstile 不達/失敗でも提出 ZIP をブロックしない。exam 等で有効。 */
  private preExportBestEffort = false;
  /** 生成時のモード (ADR-0011)。proof に自己申告ラベルとして記録する。 */
  private mode: EditorMode = 'casual';
  /** 多重 export ガード。ダウンロードボタン連打での二重 export (attestation 二重記録 /
   *  Turnstile 二重描画 / 二重ダウンロード) を防ぐ。 */
  private isExporting = false;
  /** 提出前セルフレビュー (ADR-0022, `capabilities.selfReview` で駆動)。 */
  private selfReviewEnabled = false;
  private selfReviewDialog = new SelfReviewDialog();

  constructor() {
    this.exportProgressDialog = new ExportProgressDialog();
  }

  /** 生成時のモードを設定する (ADR-0011)。proof.mode に記録される。 */
  setMode(mode: EditorMode): void {
    this.mode = mode;
  }

  /**
   * エクスポート前認証の best-effort 化を設定 (`capabilities.preExportBestEffort` で駆動)。
   * 有効時は Turnstile 認証が失敗/不達でも提出 ZIP をブロックしない (ADR-0006: サーバを
   * critical path に置かない。不安定網・100名同時でも受験者が Moodle 提出物を作れるように
   * する)。casual は従来どおり必須 (false)。
   */
  setPreExportBestEffort(bestEffort: boolean): void {
    this.preExportBestEffort = bestEffort;
  }

  /** 提出前セルフレビュー (ADR-0022) の有効化 (`capabilities.selfReview` で駆動)。 */
  setSelfReviewEnabled(enabled: boolean): void {
    this.selfReviewEnabled = enabled;
  }

  /**
   * 提出前セルフレビュー (ADR-0022): アクティブタブのプロセス要約を見せ、任意の
   * 振り返りノートを reflectionNote イベントとしてチェーンへ記録する。
   * @returns export を続行するか (false = ユーザがキャンセル)
   */
  private async performSelfReview(activeTab: TabState): Promise<boolean> {
    if (!this.selfReviewEnabled) return true;

    const summary = summarizeProcess(activeTab.typingProof.events);
    const result = await this.selfReviewDialog.show(summary);
    if (!result.proceed) return false;

    if (result.note.length > 0) {
      // ノートはチェーンに焼かれる (改ざん耐性)。exportProof が後段でチェーン完了を
      // 待つため、ここは fire-and-forget でよい (preExportAttestation と同じ経路特性)。
      await activeTab.typingProof.recordEvent({
        type: 'reflectionNote',
        data: { text: result.note },
        description: t('selfReview.recorded'),
      });
    }
    return true;
  }

  /**
   * TabManagerを設定
   */
  setTabManager(tabManager: TabManager): void {
    this.tabManager = tabManager;
  }

  /**
   * ProcessingDialogを設定
   */
  setProcessingDialog(dialog: ProcessingDialog): void {
    this.processingDialog = dialog;
  }

  /**
   * ScreenshotTrackerを設定
   */
  setScreenshotTracker(tracker: ScreenshotTracker): void {
    this.screenshotTracker = tracker;
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: ExportCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * ハッシュチェーン生成が完了するまで待機
   */
  private async waitForProcessingComplete(): Promise<boolean> {
    const activeProof = this.tabManager?.getActiveProof();
    if (!activeProof || !this.processingDialog) return true;

    return this.processingDialog.waitForComplete(() => activeProof.getStats());
  }

  /**
   * エクスポート前にTurnstile検証を実行し、attestationを記録
   * ExportProgressDialogを使用して進行状況を表示
   */
  private async performPreExportVerification(activeTab: TabState): Promise<boolean> {
    // 進行状況ダイアログを表示（検証フェーズから開始）
    this.exportProgressDialog.show();
    this.exportProgressDialog.updatePhase('verification');

    if (!isTurnstileConfigured()) {
      // 開発環境ではスキップ、次のフェーズへ
      return true;
    }

    // Turnstileスクリプトを読み込む
    try {
      await loadTurnstileScript();
    } catch (error) {
      console.error('[Export] Failed to load Turnstile script:', error);
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    }

    // ExportProgressDialogのTurnstileコンテナを使用
    const widgetContainer = this.exportProgressDialog.getTurnstileContainer();
    const parentContainer = document.getElementById('export-turnstile-container');

    if (!widgetContainer) {
      console.error('[Export] Turnstile container not found');
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    }

    const result = await performTurnstileVerification('export_proof', {
      widgetContainer,
      parentContainer: parentContainer ?? undefined,
    });

    if (!result.success || !result.attestation) {
      console.error('[Export] Pre-export verification failed:', result.error);
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    }

    // アクティブタブのTypingProofにエクスポート前attestationを記録
    await activeTab.typingProof.recordPreExportAttestation({
      success: true,
      verified: result.attestation.verified,
      score: result.attestation.score,
      action: result.attestation.action,
      timestamp: result.attestation.timestamp,
      hostname: result.attestation.hostname,
      signature: result.attestation.signature,
    });
    console.log('[Export] Pre-export attestation recorded');

    return true;
  }

  /**
   * 全タブに対してエクスポート前のTurnstile検証を実行
   * ExportProgressDialogを使用して進行状況を表示
   */
  private async performPreExportVerificationForAllTabs(): Promise<boolean> {
    // 進行状況ダイアログを表示（検証フェーズから開始）
    this.exportProgressDialog.show();
    this.exportProgressDialog.updatePhase('verification');

    if (!isTurnstileConfigured() || !this.tabManager) {
      // 開発環境ではスキップ、次のフェーズへ
      return true;
    }

    // 試験モードでは認証を best-effort 化: 試行して結果を記録するが、失敗/不達でも
    // 提出 ZIP をブロックしない (ADR-0006: サーバを critical path に置かない)。
    // 失敗時は best-effort の失敗 attestation を記録してエクスポートを続行する。
    const failOrBestEffort = async (reason: string): Promise<boolean> => {
      console.error('[Export] Pre-export verification failed:', reason);
      if (this.preExportBestEffort) {
        await this.recordBestEffortPreExportAttestation(reason);
        return true; // 提出をブロックしない
      }
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    };

    // Turnstileスクリプトを読み込む
    try {
      await loadTurnstileScript();
    } catch (error) {
      return failOrBestEffort(`script_load_failed: ${String(error)}`);
    }

    // ExportProgressDialogのTurnstileコンテナを使用
    const widgetContainer = this.exportProgressDialog.getTurnstileContainer();
    const parentContainer = document.getElementById('export-turnstile-container');

    if (!widgetContainer) {
      return failOrBestEffort('turnstile_container_missing');
    }

    const result = await performTurnstileVerification('export_proof', {
      widgetContainer,
      parentContainer: parentContainer ?? undefined,
    });

    if (!result.success || !result.attestation) {
      return failOrBestEffort(result.error ?? 'verification_failed');
    }

    // 全タブのTypingProofにエクスポート前attestationを記録
    const allTabs = this.tabManager.getAllTabs();
    for (const tab of allTabs) {
      await tab.typingProof.recordPreExportAttestation({
        success: true,
        verified: result.attestation.verified,
        score: result.attestation.score,
        action: result.attestation.action,
        timestamp: result.attestation.timestamp,
        hostname: result.attestation.hostname,
        signature: result.attestation.signature,
      });
    }
    console.log(`[Export] Pre-export attestation recorded for ${allTabs.length} tabs`);

    return true;
  }

  /**
   * 試験モードで Turnstile 認証が失敗/不達のとき、全タブに best-effort の失敗
   * attestation を記録する (ADR-0006)。これにより「認証を試みたが取得できなかった」
   * 事実がチェーンに残りつつ、提出 ZIP の生成はブロックされない。
   */
  private async recordBestEffortPreExportAttestation(reason: string): Promise<void> {
    if (!this.tabManager) return;
    const allTabs = this.tabManager.getAllTabs();
    for (const tab of allTabs) {
      await tab.typingProof.recordPreExportAttestation({
        success: false,
        verified: false,
        score: 0,
        action: 'export_proof',
        timestamp: new Date().toISOString(),
        hostname: window.location.hostname,
        signature: '',
      });
    }
    console.warn(`[Export] Exam mode: pre-export attestation best-effort (recorded failure, not blocking): ${reason}`);
  }

  /**
   * タイムスタンプ文字列を生成
   */
  private generateTimestamp(): string {
    const now = new Date();
    return `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 現在のタブをZIPでエクスポート（ソースファイル + 検証ログ）
   */
  async exportCurrentTab(): Promise<void> {
    console.log('[Export] exportCurrentTab called');

    if (this.isExporting) {
      console.warn('[Export] Export already in progress; ignoring re-entrant call');
      return;
    }
    this.isExporting = true;

    try {
      const activeTab = this.tabManager?.getActiveTab();
      console.log('[Export] activeTab:', activeTab?.filename);
      if (!activeTab) {
        console.log('[Export] No active tab');
        return;
      }

      // 提出前セルフレビュー (ADR-0022): チェーン完了待ちより前に行い、
      // 記録した reflectionNote も後段の待機/最終 checkpoint に含める。
      const reviewOk = await this.performSelfReview(activeTab);
      if (!reviewOk) {
        this.callbacks.onNotification?.(t('export.cancelled'));
        return;
      }

      // ハッシュチェーン生成完了を待機
      const completed = await this.waitForProcessingComplete();
      if (!completed) {
        this.callbacks.onNotification?.(t('export.cancelled'));
        return;
      }

      // エクスポート前にTurnstile検証を実行（ダイアログはここで表示される）
      const verified = await this.performPreExportVerification(activeTab);
      if (!verified) {
        return;
      }

      // 準備フェーズへ移行
      this.exportProgressDialog.updatePhase('preparing');

      // エクスポート前にIndexedDBへの保存を完了させる
      // V2フォーマットではsessionStorageとIndexedDBの同期が非同期のため、
      // エクスポート前に明示的に同期を取る必要がある
      await this.tabManager?.flushToIndexedDB();

      // #143: 直前の打鍵がまだ PoSW キューにあると「content には載っているのに
      // チェーンに無い」export になり content replay で fail する。先に排出を待つ。
      const drained = await activeTab.typingProof.waitForQueueDrain(5000);
      if (!drained) {
        console.warn('[ProofExporter] event queue did not drain within 5s; exporting the chain-consistent snapshot');
      }
      const content = activeTab.model.getValue();
      // exportProof() は最終 checkpoint を作成して onCheckpointCreated フックを発火する。
      // 戻り値の checkpoints は要素オブジェクトを CheckpointManager と共有するので、後段で
      // waitForFlush している間に signature が attach される (#143 でスナップショット外の
      // checkpoint は同梱されなくなったが、要素共有は変わらない)。
      const proof = await activeTab.typingProof.exportProof(content);

      // Signed checkpoint の pending リクエストを最大 5 秒待機 (オンライン時のみ意味あり)
      const flushResult = await activeTab.signedCheckpointService?.waitForFlush(5000);
      if (flushResult && !flushResult.flushed) {
        console.warn(`[ProofExporter] ${flushResult.remaining} signed checkpoint(s) remain unsigned at export time`);
      }

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = this.generateTimestamp();

      // ソースファイル名を生成（拡張子付き）
      let sourceFilename = activeTab.filename;
      const ext = getLanguageDefinition(activeTab.language)?.fileExtension ?? 'txt';
      if (!sourceFilename.endsWith(`.${ext}`)) {
        sourceFilename = `${sourceFilename}.${ext}`;
      }

      // ソースコードを追加
      zip.file(sourceFilename, content);

      // ログファイル名を生成（ファイル名_proof.json形式）
      const baseFilename = activeTab.filename.replace(/\.[^.]+$/, ''); // 拡張子を除去
      const logFilename = `${baseFilename}_proof.json`;

      // 証明JSONを追加
      const proofWithContent = {
        ...proof,
        mode: this.mode,
        filename: activeTab.filename,
        content,
        language: activeTab.language,
      };
      zip.file(logFilename, JSON.stringify(proofWithContent, null, 2));

      // スクリーンショットを追加
      this.exportProgressDialog.updatePhase('screenshots');
      const screenshotCount = await this.addScreenshotsToZip(zip);

      // READMEファイルを追加
      const readmeParams = {
        timestamp: new Date().toISOString(),
        totalFiles: 1,
        totalScreenshots: screenshotCount,
        sourceFiles: [sourceFilename],
        proofFiles: [logFilename],
      };
      zip.file('README.md', generateReadmeEn(readmeParams));
      zip.file('README.ja.md', generateReadmeJa(readmeParams));

      // ZIPを生成してダウンロード（最大圧縮）
      this.exportProgressDialog.updatePhase('generating');
      console.log('[Export] Generating ZIP...');
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9,
        },
        streamFiles: true,
      });
      console.log('[Export] ZIP generated, size:', blob.size);

      // 進行状況ダイアログを非表示
      this.exportProgressDialog.hide();

      // ダウンロード実行
      // ファイル名プレフィックス: ファイル名（拡張子なし）- baseFilenameは上で定義済み
      const zipFilename = `${baseFilename}_TC${timestamp}.zip`;
      this.downloadBlob(blob, zipFilename);
      console.log('[Export] Download triggered:', zipFilename);

      const verification = await activeTab.typingProof.verify();
      console.log('[TypedCode] Verification result:', verification);

      if (verification.valid) {
        this.callbacks.onNotification?.(t('export.successVerified'));
      } else {
        this.callbacks.onNotification?.(t('export.verifyFailed'));
      }
    } catch (error) {
      console.error('[TypedCode] Export failed:', error);
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.failed'));
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * 全タブをZIPでエクスポート
   */
  async exportAllTabsAsZip(): Promise<void> {
    if (this.isExporting) {
      console.warn('[Export] Export already in progress; ignoring re-entrant call');
      return;
    }
    this.isExporting = true;

    try {
      if (!this.tabManager) return;

      // タブが存在しない場合は何もしない
      if (this.tabManager.getAllTabs().length === 0) {
        console.log('[Export] No tabs to export');
        return;
      }

      // 提出前セルフレビュー (ADR-0022): 一括 export では 1 回だけ表示し、
      // ノートはアクティブタブのチェーンへ記録する (タブ毎 N 回は摩擦過多)。
      const activeTabForReview = this.tabManager.getActiveTab();
      if (activeTabForReview) {
        const reviewOk = await this.performSelfReview(activeTabForReview);
        if (!reviewOk) {
          this.callbacks.onNotification?.(t('export.cancelled'));
          return;
        }
      }

      // ハッシュチェーン生成完了を待機
      const completed = await this.waitForProcessingComplete();
      if (!completed) {
        this.callbacks.onNotification?.(t('export.cancelled'));
        return;
      }

      // エクスポート前にTurnstile検証を実行（ダイアログはここで表示される）
      const verified = await this.performPreExportVerificationForAllTabs();
      if (!verified) {
        return;
      }

      // 準備フェーズへ移行
      this.exportProgressDialog.updatePhase('preparing');

      // エクスポート前にIndexedDBへの保存を完了させる
      // V2フォーマットではsessionStorageとIndexedDBの同期が非同期のため、
      // エクスポート前に明示的に同期を取る必要がある
      await this.tabManager.flushToIndexedDB();

      const allTabs = this.tabManager.getAllTabs();

      // マルチタブ: 各 tab.typingProof.exportProof() が最終 checkpoint を作って
      // フックを起こす → その後に並列 flush。先に各 exportProof を走らせ proof を作り、
      // 最後に全タブの signing flush を待ってからシリアライズする。

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = this.generateTimestamp();

      // ファイル名の重複を処理するためのマップ
      const usedSourceFilenames = new Map<string, number>();
      const usedLogFilenames = new Map<string, number>();

      // 各タブをエクスポート
      const fileList: string[] = [];
      const logList: string[] = [];

      let tabIndex = 0;
      for (const tab of allTabs) {
        // 進行状況を更新
        this.exportProgressDialog.updateProgress({
          phase: 'preparing',
          current: tabIndex + 1,
          total: allTabs.length,
        });

        // #143: waitForProcessingComplete はアクティブタブしか待たない。タブ毎に
        // キュー排出を待ってから content を確定する (排出しきれなくてもスナップショット
        // 一貫性で proof 自体は整合するが、直前の打鍵が export に載らない)。
        const drained = await tab.typingProof.waitForQueueDrain(5000);
        if (!drained) {
          console.warn(`[ProofExporter] tab ${tab.id}: event queue did not drain within 5s`);
        }
        const content = tab.model.getValue();
        const proof = await tab.typingProof.exportProof(content);

        // 最終 checkpoint が作成された直後で signing が pending な可能性がある。
        // JSON シリアライズ前に最大 5 秒待機して envelope を反映させる。
        const flushResult = await tab.signedCheckpointService?.waitForFlush(5000);
        if (flushResult && !flushResult.flushed) {
          console.warn(`[ProofExporter] tab ${tab.id}: ${flushResult.remaining} unsigned checkpoint(s) at export time`);
        }

        // ソースファイル名を生成（拡張子付き）
        let sourceFilename = tab.filename;
        const ext = getLanguageDefinition(tab.language)?.fileExtension ?? 'txt';
        if (!sourceFilename.endsWith(`.${ext}`)) {
          sourceFilename = `${sourceFilename}.${ext}`;
        }

        // ソースファイル名の重複を処理
        let uniqueSourceFilename = sourceFilename;
        const sourceCount = usedSourceFilenames.get(sourceFilename) ?? 0;
        if (sourceCount > 0) {
          const baseName = sourceFilename.replace(/\.[^.]+$/, '');
          const extension = sourceFilename.match(/\.[^.]+$/)?.[0] ?? '';
          uniqueSourceFilename = `${baseName}_${sourceCount}${extension}`;
        }
        usedSourceFilenames.set(sourceFilename, sourceCount + 1);

        // ソースコードを追加（フラット）
        zip.file(uniqueSourceFilename, content);
        fileList.push(uniqueSourceFilename);

        // ログファイル名を生成（ファイル名_proof.json形式）
        const baseFilename = tab.filename.replace(/\.[^.]+$/, ''); // 拡張子を除去
        let logFilename = `${baseFilename}_proof.json`;

        // ログファイル名の重複を処理
        const logCount = usedLogFilenames.get(logFilename) ?? 0;
        if (logCount > 0) {
          logFilename = `${baseFilename}_proof_${logCount}.json`;
        }
        usedLogFilenames.set(`${baseFilename}_proof.json`, logCount + 1);

        // 証明JSONを追加（フラット）
        const proofWithContent = {
          ...proof,
          mode: this.mode,
          filename: tab.filename,
          content,
          language: tab.language,
        };
        zip.file(logFilename, JSON.stringify(proofWithContent, null, 2));
        logList.push(logFilename);
        tabIndex++;
      }

      // スクリーンショットを追加
      this.exportProgressDialog.updatePhase('screenshots');
      const screenshotCount = await this.addScreenshotsToZip(zip);

      // READMEファイルを追加
      const readmeParams = {
        timestamp: new Date().toISOString(),
        totalFiles: allTabs.length,
        totalScreenshots: screenshotCount,
        sourceFiles: fileList,
        proofFiles: logList,
      };
      zip.file('README.md', generateReadmeEn(readmeParams));
      zip.file('README.ja.md', generateReadmeJa(readmeParams));

      // タブ間切替の監査証跡 (ADR-0007/0010)。複数タブ提出 (exam/class) で「いつどの問題に
      // 移ったか」を残す。各タブ proof は独立しているため、この情報は別ファイルで同梱する。
      const tabSwitches = this.tabManager?.getTabSwitches() ?? [];
      if (tabSwitches.length > 0) {
        zip.file('tab-switches.json', JSON.stringify(tabSwitches, null, 2));
      }

      // ZIPを生成してダウンロード（最大圧縮）
      this.exportProgressDialog.updatePhase('generating');
      console.log('[Export] Generating ZIP for all tabs...');
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9, // 最大圧縮レベル
        },
        streamFiles: true,
      });
      console.log('[Export] ZIP generated, size:', blob.size);

      // 進行状況ダイアログを非表示
      this.exportProgressDialog.hide();

      // ダウンロード実行
      // 全ファイルエクスポート時のプレフィックス: ALL_
      const zipFilename = `ALL_TC${timestamp}.zip`;
      this.downloadBlob(blob, zipFilename);
      console.log('[Export] Download triggered:', zipFilename);

      this.callbacks.onNotification?.(t('export.zipSuccess', { count: allTabs.length }));
    } catch (error) {
      console.error('[TypedCode] ZIP export failed:', error);
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.zipFailed'));
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Blobをダウンロード
   */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);

    // アンカー要素を作成してDOMに追加（一部のブラウザで必要）
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);

    // クリックイベントを発火
    a.click();

    // クリーンアップ（少し遅延させてダウンロードが開始されるのを待つ）
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * スクリーンショットをZIPに追加
   * @returns 追加されたスクリーンショット数
   */
  private async addScreenshotsToZip(zip: JSZip): Promise<number> {
    console.log('[Export] addScreenshotsToZip called, screenshotTracker:', !!this.screenshotTracker);

    if (!this.screenshotTracker) {
      console.log('[Export] No screenshotTracker, skipping screenshots');
      return 0;
    }

    try {
      console.log('[Export] Getting screenshots for export...');
      const screenshots = await this.screenshotTracker.getScreenshotsForExport();
      console.log('[Export] Got screenshots:', screenshots.size);

      if (screenshots.size === 0) {
        console.log('[Export] No screenshots to export');
        return 0;
      }

      const screenshotsFolder = zip.folder('screenshots');
      if (!screenshotsFolder) {
        console.error('[Export] Failed to create screenshots folder');
        return 0;
      }

      // 画像ファイルを追加
      for (const [filename, blob] of screenshots) {
        screenshotsFolder.file(filename, blob);
      }

      // マニフェストファイルを追加（ScreenshotManifest形式でラップ）
      const screenshotEntries = await this.screenshotTracker.getManifestForExport();
      const manifest = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        totalScreenshots: screenshots.size,
        screenshots: screenshotEntries,
      };
      screenshotsFolder.file('manifest.json', JSON.stringify(manifest, null, 2));

      console.log(`[Export] Added ${screenshots.size} screenshots to ZIP`);
      return screenshots.size;
    } catch (error) {
      console.error('[Export] Failed to add screenshots:', error);
      return 0;
    }
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.tabManager = null;
    this.processingDialog = null;
    this.screenshotTracker = null;
    this.callbacks = {};
  }
}
