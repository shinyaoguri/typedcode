/**
 * ProofExporter - 証明データのエクスポート機能
 * 単一タブおよび複数タブのエクスポートを管理
 */

import JSZip from 'jszip';
import type { TabManager, TabState } from '../ui/tabs/TabManager.js';
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

export interface ExportCallbacks {
  onNotification?: (message: string) => void;
}

export class ProofExporter {
  private tabManager: TabManager | null = null;
  private processingDialog: ProcessingDialog | null = null;
  private exportProgressDialog: ExportProgressDialog;
  private screenshotTracker: ScreenshotTracker | null = null;
  private callbacks: ExportCallbacks = {};

  constructor() {
    this.exportProgressDialog = new ExportProgressDialog();
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

    try {
      const activeTab = this.tabManager?.getActiveTab();
      console.log('[Export] activeTab:', activeTab?.filename);
      if (!activeTab) {
        console.log('[Export] No active tab');
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

      const content = activeTab.model.getValue();
      const proof = await activeTab.typingProof.exportProof(content);

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
      });
      console.log('[Export] ZIP generated, size:', blob.size);

      // 進行状況ダイアログを非表示
      this.exportProgressDialog.hide();

      // ダウンロード実行
      const filename = `TC${timestamp}.zip`;
      this.downloadBlob(blob, filename);
      console.log('[Export] Download triggered:', filename);

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
    }
  }

  /**
   * 全タブをZIPでエクスポート
   */
  async exportAllTabsAsZip(): Promise<void> {
    try {
      if (!this.tabManager) return;

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

      const allTabs = this.tabManager.getAllTabs();

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = this.generateTimestamp();

      // ファイル名の重複を処理するためのマップ
      const usedSourceFilenames = new Map<string, number>();
      const usedLogFilenames = new Map<string, number>();

      // 各タブをエクスポート
      const fileList: string[] = [];
      const logList: string[] = [];

      for (let i = 0; i < allTabs.length; i++) {
        const tab = allTabs[i];
        // 進行状況を更新
        this.exportProgressDialog.updateProgress({
          phase: 'preparing',
          current: i + 1,
          total: allTabs.length,
        });

        const content = tab.model.getValue();
        const proof = await tab.typingProof.exportProof(content);

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
          filename: tab.filename,
          content,
          language: tab.language,
        };
        zip.file(logFilename, JSON.stringify(proofWithContent, null, 2));
        logList.push(logFilename);
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

      // ZIPを生成してダウンロード（最大圧縮）
      this.exportProgressDialog.updatePhase('generating');
      console.log('[Export] Generating ZIP for all tabs...');
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9, // 最大圧縮レベル
        },
      });
      console.log('[Export] ZIP generated, size:', blob.size);

      // 進行状況ダイアログを非表示
      this.exportProgressDialog.hide();

      // ダウンロード実行
      const filename = `TC${timestamp}.zip`;
      this.downloadBlob(blob, filename);
      console.log('[Export] Download triggered:', filename);

      this.callbacks.onNotification?.(t('export.zipSuccess', { count: allTabs.length }));
    } catch (error) {
      console.error('[TypedCode] ZIP export failed:', error);
      this.exportProgressDialog.hide();
      this.callbacks.onNotification?.(t('export.zipFailed'));
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

      // マニフェストファイルを追加
      const manifest = await this.screenshotTracker.getManifestForExport();
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
