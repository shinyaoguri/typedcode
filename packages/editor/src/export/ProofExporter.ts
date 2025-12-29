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

    this.callbacks.onNotification?.('エクスポート前の認証を実行中...');

    const result = await performTurnstileVerification('export_proof');

    if (!result.success || !result.attestation) {
      console.error('[Export] Pre-export verification failed:', result.error);
      this.callbacks.onNotification?.('エクスポート前の認証に失敗しました');
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

    this.callbacks.onNotification?.('エクスポート前の認証を実行中...');

    const result = await performTurnstileVerification('export_proof');

    if (!result.success || !result.attestation) {
      console.error('[Export] Pre-export verification failed:', result.error);
      this.callbacks.onNotification?.('エクスポート前の認証に失敗しました');
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
   * 単一タブの証明データをエクスポート
   */
  async exportSingleTab(): Promise<void> {
    try {
      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;

      // ハッシュチェーン生成完了を待機
      const completed = await this.waitForProcessingComplete();
      if (!completed) {
        this.callbacks.onNotification?.('エクスポートがキャンセルされました');
        return;
      }

      // エクスポート前にTurnstile検証を実行
      const verified = await this.performPreExportVerification(activeTab);
      if (!verified) {
        return;
      }

      const proofData = await this.tabManager!.exportSingleTab(activeTab.id);
      if (!proofData) return;

      const exportData = {
        ...proofData,
        content: activeTab.model.getValue(),
        language: activeTab.language,
      };

      const jsonString = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const timestamp = this.generateTimestamp();
      const tabFilename = activeTab.filename.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `TC_${tabFilename}_${timestamp}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      console.log('[TypedCode] Proof exported successfully');
      console.log('Total events:', proofData.proof.totalEvents);
      console.log('Final hash:', proofData.proof.finalHash);
      console.log('Signature:', proofData.proof.signature);

      const verification = await activeTab.typingProof.verify();
      console.log('[TypedCode] Verification result:', verification);

      if (verification.valid) {
        this.callbacks.onNotification?.('証明データをエクスポートしました（検証: OK）');
      } else {
        this.callbacks.onNotification?.('警告: ハッシュ鎖の検証に失敗しました');
      }
    } catch (error) {
      console.error('[TypedCode] Export failed:', error);
      this.callbacks.onNotification?.('エクスポートに失敗しました');
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
        this.callbacks.onNotification?.('エクスポートがキャンセルされました');
        return;
      }

      // エクスポート前にTurnstile検証を実行（全タブに適用）
      const verified = await this.performPreExportVerificationForAllTabs();
      if (!verified) {
        return;
      }

      const multiProofData = await this.tabManager.exportAllTabs();

      // ZIPファイルを作成
      const zip = new JSZip();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // 各ファイルを追加
      for (const [filename, fileData] of Object.entries(multiProofData.files)) {
        zip.file(filename, fileData.content);
      }

      // マルチファイル証明ファイルを追加
      const jsonString = JSON.stringify(multiProofData, null, 2);
      zip.file(`typedcode-multi-proof-${timestamp}.json`, jsonString);

      // READMEを追加
      const fileList = Object.keys(multiProofData.files).map(f => `- ${f}`).join('\n');
      const readme = `TypedCode Multi-File Export
===========================

This archive contains:
${fileList}
- typedcode-multi-proof-${timestamp}.json: Multi-file typing proof data

To verify this proof:
1. Visit the TypedCode verification page
2. Drop the proof JSON file to verify

Generated: ${new Date().toISOString()}
Total files: ${multiProofData.metadata.totalFiles}
Pure typing: ${multiProofData.metadata.overallPureTyping ? 'Yes' : 'No'}
`;
      zip.file('README.txt', readme);

      // ZIPを生成してダウンロード
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `typedcode-${timestamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      this.callbacks.onNotification?.(
        `ZIPファイルをダウンロードしました（${multiProofData.metadata.totalFiles}ファイル）`
      );
    } catch (error) {
      console.error('[TypedCode] ZIP export failed:', error);
      this.callbacks.onNotification?.('ZIPエクスポートに失敗しました');
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
