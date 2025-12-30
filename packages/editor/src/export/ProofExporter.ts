/**
 * ProofExporter - 証明データのエクスポート機能
 * 単一タブおよび複数タブのエクスポートを管理
 */

import JSZip from 'jszip';
import type { TabManager, TabState } from '../ui/tabs/TabManager.js';
import type { ProcessingDialog } from '../ui/components/ProcessingDialog.js';
import {
  isTurnstileConfigured,
  performTurnstileVerification,
} from '../services/TurnstileService.js';
import { getLanguageDefinition } from '../config/SupportedLanguages.js';
import { t } from '../i18n/index.js';

export interface ExportCallbacks {
  onNotification?: (message: string) => void;
}

export class ProofExporter {
  private tabManager: TabManager | null = null;
  private processingDialog: ProcessingDialog | null = null;
  private callbacks: ExportCallbacks = {};

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
   */
  private async performPreExportVerification(activeTab: TabState): Promise<boolean> {
    if (!isTurnstileConfigured()) {
      return true; // 開発環境ではスキップ
    }

    this.callbacks.onNotification?.(t('export.preAuthRunning'));

    const result = await performTurnstileVerification('export_proof');

    if (!result.success || !result.attestation) {
      console.error('[Export] Pre-export verification failed:', result.error);
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    }

    // アクティブタブのTypingProofにエクスポート前attestationを記録
    await activeTab.typingProof.recordPreExportAttestation({
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
   */
  private async performPreExportVerificationForAllTabs(): Promise<boolean> {
    if (!isTurnstileConfigured() || !this.tabManager) {
      return true;
    }

    this.callbacks.onNotification?.(t('export.preAuthRunning'));

    const result = await performTurnstileVerification('export_proof');

    if (!result.success || !result.attestation) {
      console.error('[Export] Pre-export verification failed:', result.error);
      this.callbacks.onNotification?.(t('export.preAuthFailed'));
      return false;
    }

    // 全タブのTypingProofにエクスポート前attestationを記録
    const allTabs = this.tabManager.getAllTabs();
    for (const tab of allTabs) {
      await tab.typingProof.recordPreExportAttestation({
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
    try {
      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;

      // ハッシュチェーン生成完了を待機
      const completed = await this.waitForProcessingComplete();
      if (!completed) {
        this.callbacks.onNotification?.(t('export.cancelled'));
        return;
      }

      // エクスポート前にTurnstile検証を実行
      const verified = await this.performPreExportVerification(activeTab);
      if (!verified) {
        return;
      }

      const content = activeTab.model.getValue();
      const proof = await activeTab.typingProof.exportProof(content);

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = this.generateTimestamp();
      const isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // ソースファイル名を生成（拡張子付き）
      let sourceFilename = activeTab.filename;
      const ext = getLanguageDefinition(activeTab.language)?.fileExtension ?? 'txt';
      if (!sourceFilename.endsWith(`.${ext}`)) {
        sourceFilename = `${sourceFilename}.${ext}`;
      }

      // ソースコードを追加
      zip.file(sourceFilename, content);

      // ログファイル名を生成
      const tabFilename = activeTab.filename.replace(/[^a-zA-Z0-9_-]/g, '_');
      const logFilename = `TC_${tabFilename}_${timestamp}.json`;

      // 証明JSONを追加
      const proofWithContent = {
        ...proof,
        filename: activeTab.filename,
        content,
        language: activeTab.language,
      };
      zip.file(logFilename, JSON.stringify(proofWithContent, null, 2));

      // ZIPを生成してダウンロード（最大圧縮）
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9,
        },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `typedcode-${tabFilename}-${isoTimestamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      const verification = await activeTab.typingProof.verify();
      console.log('[TypedCode] Verification result:', verification);

      if (verification.valid) {
        this.callbacks.onNotification?.(t('export.successVerified'));
      } else {
        this.callbacks.onNotification?.(t('export.verifyFailed'));
      }
    } catch (error) {
      console.error('[TypedCode] Export failed:', error);
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

      // エクスポート前にTurnstile検証を実行（全タブに適用）
      const verified = await this.performPreExportVerificationForAllTabs();
      if (!verified) {
        return;
      }

      const allTabs = this.tabManager.getAllTabs();

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = this.generateTimestamp();
      const isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // ファイル名の重複を処理するためのマップ
      const usedSourceFilenames = new Map<string, number>();
      const usedLogFilenames = new Map<string, number>();

      // 各タブをエクスポート
      const fileList: string[] = [];
      const logList: string[] = [];

      for (const tab of allTabs) {
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

        // ログファイル名を生成（個別出力と同じ形式: TC_{tabFilename}_{timestamp}.json）
        const tabFilename = tab.filename.replace(/[^a-zA-Z0-9_-]/g, '_');
        let logFilename = `TC_${tabFilename}_${timestamp}.json`;

        // ログファイル名の重複を処理
        const logCount = usedLogFilenames.get(logFilename) ?? 0;
        if (logCount > 0) {
          logFilename = `TC_${tabFilename}_${timestamp}_${logCount}.json`;
        }
        usedLogFilenames.set(`TC_${tabFilename}_${timestamp}.json`, logCount + 1);

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

      // READMEを追加
      const filesSection = fileList.map(f => `- ${f}`).join('\n');
      const logsSection = logList.map(f => `- ${f}`).join('\n');
      const readme = `TypedCode Multi-File Export
===========================

This archive contains:

## Source Files
${filesSection}

## Typing Proof Logs
${logsSection}

Each log file contains:
- typingProofHash: Unique hash of the typing proof
- proof.events: All recorded events (keystrokes, edits, etc.)
- fingerprint: Device information
- metadata: Pure typing status, timestamps

To verify:
1. Visit the TypedCode verification page
2. Drop any log JSON file to verify

Generated: ${new Date().toISOString()}
Total files: ${allTabs.length}
`;
      zip.file('README.txt', readme);

      // ZIPを生成してダウンロード（最大圧縮）
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9, // 最大圧縮レベル
        },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `typedcode-${isoTimestamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      this.callbacks.onNotification?.(t('export.zipSuccess', { count: allTabs.length }));
    } catch (error) {
      console.error('[TypedCode] ZIP export failed:', error);
      this.callbacks.onNotification?.(t('export.zipFailed'));
    }
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.tabManager = null;
    this.processingDialog = null;
    this.callbacks = {};
  }
}
