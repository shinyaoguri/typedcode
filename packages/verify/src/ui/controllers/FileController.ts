/**
 * FileController - ファイル処理を担当するコントローラー
 */
import type { FileProcessor, ParsedFileData } from '../../services/FileProcessor';
import type { ScreenshotService } from '../../services/ScreenshotService';
import type { VerifyTabManager } from '../../state/VerifyTabManager';
import type { UIStateManager } from '../../state/UIStateManager';
import type { VerificationQueue } from '../../state/VerificationQueue';
import type { Sidebar } from '../Sidebar';
import type { StatusBarUI } from '../StatusBarUI';
import type { ProofFile, VerifyScreenshot, DiffResult, ContentMismatchInfo } from '../../types';
import { t } from '../../i18n/index';
import { DiffService } from '../../services/DiffService';

export interface FileControllerDependencies {
  fileProcessor: FileProcessor;
  tabManager: VerifyTabManager;
  uiState: UIStateManager;
  verificationQueue: VerificationQueue;
  sidebar: Sidebar;
  statusBar: StatusBarUI;
  generateId: () => string;
  onScreenshotServiceUpdate?: (service: ScreenshotService) => void;
  onStatusBarUpdate?: () => void;
}

export class FileController {
  private deps: FileControllerDependencies;

  /**
   * proofファイルのcontentを保存するマップ
   * folderId -> (baseFilename -> content)
   * 例: "folder123" -> ("main" -> "int main() {...}")
   */
  private proofContentMap: Map<string, Map<string, string>> = new Map();

  /**
   * proofファイルのIDを保存するマップ（ソースファイル不一致時の更新用）
   * folderId -> (baseFilename -> proofTabId)
   * 例: "folder123" -> ("main" -> "tab456")
   */
  private proofIdMap: Map<string, Map<string, string>> = new Map();

  constructor(deps: FileControllerDependencies) {
    this.deps = deps;
  }

  /**
   * ファイルを処理
   */
  async processFile(file: File): Promise<void> {
    try {
      const result = await this.deps.fileProcessor.process(file);

      if (!result.success) {
        this.deps.statusBar.setError(result.error || t('errors.fileReadError'));
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
          const folderId = this.deps.generateId();
          const parts = folderPath.split('/');
          const folderName = parts[parts.length - 1];
          const parentPath = parts.slice(0, -1).join('/');
          const parentId = folderMap.get(parentPath) ?? rootFolderId;
          const depth = parts.length;

          // screenshotsフォルダはデフォルトで閉じた状態
          const isScreenshotsFolder = folderName === 'screenshots' || folderPath.startsWith('screenshots/');
          const expanded = isScreenshotsFolder ? false : depth <= 1;

          this.deps.sidebar.addHierarchicalFolder({
            id: folderId,
            name: folderName ?? '',
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
      if (result.screenshotService && this.deps.onScreenshotServiceUpdate) {
        this.deps.onScreenshotServiceUpdate(result.screenshotService);
      }

      // ZIPファイルの場合、proof contentマップとIDマップをクリア
      if (file.name.endsWith('.zip') && rootFolderId) {
        this.proofContentMap.set(rootFolderId, new Map());
        this.proofIdMap.set(rootFolderId, new Map());
      }

      // 2パスで処理: 1) proofファイル、2) plaintext/imageファイル
      // これにより、plaintextファイル処理時にproofのcontentを参照できる
      const proofFiles = result.files.filter((f) => f.type === 'proof');
      const otherFiles = result.files.filter((f) => f.type !== 'proof');

      // パス1: proofファイルを先に処理
      for (const fileData of proofFiles) {
        let folderId = rootFolderId;
        if (fileData.relativePath) {
          const parts = fileData.relativePath.split('/');
          const parentPath = parts.slice(0, -1).join('/');
          folderId = folderMap.get(parentPath) ?? rootFolderId;
        }
        this.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath, result.screenshots, result.startTimestamp);
      }

      // パス2: plaintext/imageファイルを処理
      for (const fileData of otherFiles) {
        // ファイルの親フォルダを特定
        let folderId = rootFolderId;
        if (fileData.relativePath) {
          const parts = fileData.relativePath.split('/');
          const parentPath = parts.slice(0, -1).join('/');
          folderId = folderMap.get(parentPath) ?? rootFolderId;
        }

        if (fileData.type === 'image') {
          this.addImageFile(fileData, folderId);
        } else {
          this.addPlaintextFile(fileData, folderId);
        }
      }
    } catch (error) {
      console.error('Error processing file:', error);
      this.deps.statusBar.setError(`${t('errors.fileReadError')}: ${file.name}`);
    }
  }

  /**
   * ZIP用フォルダを作成
   */
  private createFolderForZip(zipFilename: string): string {
    const folderId = this.deps.generateId();
    // ZIPファイル名から拡張子を除去してフォルダ名とする
    const folderName = this.deps.uiState.generateFolderName(zipFilename.replace(/\.zip$/i, ''));

    this.deps.sidebar.addFolder({
      id: folderId,
      name: folderName,
      expanded: true, // デフォルトで展開
    });

    return folderId;
  }

  /**
   * プレーンテキストファイルを追加（読み取り専用）
   * 同じフォルダ内に対応するproofファイルがあれば差分比較を行う
   */
  addPlaintextFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.deps.generateId();
    const displayName = this.deps.uiState.generateDisplayName(fileData.filename, folderId);

    // 対応するproofファイルのcontentを検索して差分を計算
    let diffResult: DiffResult | undefined;
    let hasContentMismatch = false;
    let associatedProofContent: string | undefined;
    let associatedProofId: string | undefined;

    if (folderId && fileData.rawData) {
      const folderProofs = this.proofContentMap.get(folderId);
      const folderProofIds = this.proofIdMap.get(folderId);
      if (folderProofs) {
        // ファイル名からベース名を抽出（拡張子を除去）
        const baseFilename = fileData.filename.replace(/\.[^.]+$/, '');
        const proofContent = folderProofs.get(baseFilename);
        associatedProofId = folderProofIds?.get(baseFilename);

        if (proofContent !== undefined) {
          associatedProofContent = proofContent;
          diffResult = DiffService.compare(fileData.rawData, proofContent);
          hasContentMismatch = !diffResult.isIdentical;

          if (hasContentMismatch) {
            console.log(`[FileController] Content mismatch detected for ${fileData.filename}:`, {
              additions: diffResult.stats.additions,
              deletions: diffResult.stats.deletions,
              associatedProofId,
            });

            // 対応するproofファイルのタブ情報も更新（不一致情報を追加）
            if (associatedProofId) {
              const mismatchInfo: ContentMismatchInfo = {
                filename: fileData.filename,
                additions: diffResult.stats.additions,
                deletions: diffResult.stats.deletions,
              };
              this.deps.tabManager.updateTab(associatedProofId, {
                associatedSourceMismatch: mismatchInfo,
              });
              // サイドバーのproofファイルアイコンも警告に更新
              this.deps.sidebar.updateFileStatus(associatedProofId, 'warning');
            }
          }
        }
      }
    }

    // Add to tab manager (plaintext file - no verification)
    this.deps.tabManager.addTab({
      id,
      filename: displayName,
      language: fileData.language,
      status: hasContentMismatch ? 'warning' : 'success', // 差分がある場合は警告状態
      progress: 100,
      proofData: null,
      verificationResult: null,
      isPlaintext: true, // プレーンテキストフラグ
      plaintextContent: fileData.rawData,
      associatedProofContent,
      diffResult,
      hasContentMismatch,
    });

    // Add to sidebar (file list)
    this.deps.sidebar.addFile({
      id,
      filename: displayName,
      status: hasContentMismatch ? 'warning' : 'success', // 差分がある場合は警告アイコン
      folderId,
      isProof: false, // プレーンテキストファイル
    });

    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 画像ファイルを追加（プレビュー表示用）
   */
  addImageFile(fileData: ParsedFileData, folderId?: string): void {
    const id = this.deps.generateId();
    const displayName = this.deps.uiState.generateDisplayName(fileData.filename, folderId);

    // Add to tab manager (image file - no verification)
    this.deps.tabManager.addTab({
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
    this.deps.sidebar.addFile({
      id,
      filename: displayName,
      status: 'success',
      folderId,
      isProof: false,
      isImage: true, // 画像ファイル
    });

    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 検証用ファイルを追加
   */
  addFileToVerification(
    filename: string,
    rawData: string,
    folderId?: string,
    relativePath?: string,
    screenshots?: VerifyScreenshot[],
    startTimestamp?: number
  ): void {
    console.log('[FileController] addFileToVerification:', {
      filename,
      screenshotsCount: screenshots?.length ?? 0,
      startTimestamp,
    });

    try {
      const proofData = JSON.parse(rawData) as ProofFile;
      const id = this.deps.generateId();

      // 表示名を生成（重複がある場合は番号を付ける）
      const displayName = this.deps.uiState.generateDisplayName(filename, folderId);

      // proofファイルのcontentとIDをマップに保存（差分比較用）
      // ファイル名から_proofを除去してベース名を取得
      // 例: "main_proof.json" -> "main"
      const baseFilename = filename.replace(/_proof\.json$/i, '').replace(/\.json$/i, '');

      if (folderId && proofData.content) {
        let folderProofs = this.proofContentMap.get(folderId);
        if (!folderProofs) {
          folderProofs = new Map();
          this.proofContentMap.set(folderId, folderProofs);
        }
        folderProofs.set(baseFilename, proofData.content);
      }

      // proofファイルIDをマップに保存（ソースファイル不一致時の更新用）
      if (folderId) {
        let folderProofIds = this.proofIdMap.get(folderId);
        if (!folderProofIds) {
          folderProofIds = new Map();
          this.proofIdMap.set(folderId, folderProofIds);
        }
        folderProofIds.set(baseFilename, id);
      }

      // startTimestampが渡されていない場合は計算
      let computedStartTimestamp = startTimestamp;
      if (!computedStartTimestamp && proofData.metadata?.timestamp && proofData.proof?.events?.length > 0) {
        const exportedAt = proofData.metadata.timestamp;
        const totalTime = proofData.proof.events[proofData.proof.events.length - 1]?.timestamp ?? 0;
        const exportTimestamp = new Date(exportedAt).getTime();
        computedStartTimestamp = exportTimestamp - totalTime;
      }

      // Add to tab manager (state management)
      this.deps.tabManager.addTab({
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
      this.deps.sidebar.addFile({
        id,
        filename: displayName,
        status: 'pending',
        folderId, // フォルダに属する場合
        relativePath, // File System Access API用のパス
        isProof: true, // 検証用ファイル
      });

      // Track counts
      this.deps.uiState.incrementTotal();

      // Enqueue for verification
      this.deps.verificationQueue.enqueue({
        id,
        filename,
        rawData,
      });

      // Update status bar
      this.deps.onStatusBarUpdate?.();
    } catch (error) {
      console.error('Error parsing JSON:', error);
      this.deps.statusBar.setError(`JSONパースエラー: ${filename}`);
    }
  }
}
