/**
 * FolderController - フォルダ同期を担当するコントローラー
 */
import { FileSystemAccessService } from '../../services/FileSystemAccessService';
import { FolderSyncManager } from '../../services/FolderSyncManager';
import { ScreenshotService } from '../../services/ScreenshotService';
import type { FileProcessor, ParsedFileData } from '../../services/FileProcessor';
import type { VerifyTabManager } from '../../state/VerifyTabManager';
import type { VerificationQueue } from '../../state/VerificationQueue';
import type { Sidebar } from '../Sidebar';
import type { TabBar } from '../TabBar';
import type { StatusBarUI } from '../StatusBarUI';
import type { FSAccessFileEntry, HierarchicalFolder, VerifyScreenshot, ScreenshotManifest } from '../../types';
import { t } from '../../i18n/index';

export interface FolderControllerDependencies {
  fileProcessor: FileProcessor;
  tabManager: VerifyTabManager;
  verificationQueue: VerificationQueue;
  sidebar: Sidebar;
  tabBar: TabBar;
  statusBar: StatusBarUI;
  generateId: () => string;
  addFileToVerification: (
    filename: string,
    rawData: string,
    folderId?: string,
    relativePath?: string,
    screenshots?: VerifyScreenshot[],
    startTimestamp?: number
  ) => void;
  addPlaintextFile: (fileData: ParsedFileData, folderId?: string) => void;
  addImageFile: (fileData: ParsedFileData, folderId?: string) => void;
  onScreenshotServiceUpdate?: (service: ScreenshotService) => void;
  onStatusBarUpdate?: () => void;
  onFileRemove?: (id: string) => void;
}

export class FolderController {
  private deps: FolderControllerDependencies;
  private fsAccessService: FileSystemAccessService;
  private syncManager: FolderSyncManager;
  private watchedRootHandle: FileSystemDirectoryHandle | null = null;
  private watchedRootFolderId: string | null = null;

  constructor(deps: FolderControllerDependencies) {
    this.deps = deps;

    // Initialize File System Access API
    this.fsAccessService = new FileSystemAccessService({
      onPermissionDenied: (error) => {
        this.deps.statusBar.setError(`${t('errors.accessDenied')}: ${error.message}`);
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
  }

  /**
   * File System Access API がサポートされているか
   */
  isSupported(): boolean {
    return FileSystemAccessService.isSupported();
  }

  /**
   * フォルダ選択ダイアログを開く
   */
  async openFolderDialog(): Promise<void> {
    if (!this.isSupported()) {
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
      this.deps.statusBar.setError(result.error ?? t('errors.folderReadError'));
      return;
    }

    // スクリーンショットフォルダを検出して読み込む
    let folderScreenshots: VerifyScreenshot[] | undefined;
    let folderStartTimestamp: number | undefined;
    try {
      const loadResult = await this.loadScreenshotsFromFolder(handle);
      if (loadResult) {
        folderScreenshots = loadResult.screenshots;
        folderStartTimestamp = loadResult.startTimestamp;
        console.log(`[FolderController] Loaded ${folderScreenshots.length} screenshots from folder`);
      }
    } catch (error) {
      console.log('[FolderController] No screenshots folder found or error loading:', error);
    }

    // ルートフォルダを作成
    const rootFolderId = this.deps.generateId();
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

    this.deps.sidebar.addHierarchicalFolder(rootFolder);
    this.watchedRootFolderId = rootFolderId;

    // サブフォルダを追加（screenshotsフォルダも含める）
    const folderMap = new Map<string, string>(); // path -> folderId
    folderMap.set('', rootFolderId);

    // フォルダをソートしてから追加（親フォルダが先に処理されるように）
    const sortedFolders = result.folders
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const folder of sortedFolders) {
      const folderId = this.deps.generateId();
      const parentPath = folder.path.split('/').slice(0, -1).join('/');
      const parentId = folderMap.get(parentPath) ?? rootFolderId;
      const depth = folder.path.split('/').length;

      // screenshotsフォルダはデフォルトで閉じた状態
      const isScreenshotsFolder = folder.name === 'screenshots' || folder.path.startsWith('screenshots/');
      const expanded = isScreenshotsFolder ? false : depth <= 1;

      const hierarchicalFolder: HierarchicalFolder = {
        id: folderId,
        name: folder.name,
        path: folder.path,
        parentId,
        expanded,
        depth,
        sourceType: 'fsaccess',
        directoryHandle: folder.handle,
      };

      this.deps.sidebar.addHierarchicalFolder(hierarchicalFolder);
      folderMap.set(folder.path, folderId);
    }

    // ファイルを処理（スクリーンショット情報を渡す）
    for (const fileEntry of result.files) {
      await this.processFileFromHandle(fileEntry, folderMap, folderScreenshots, folderStartTimestamp);
    }

    // 監視を開始
    this.watchedRootHandle = handle;
    await this.syncManager.startWatching(handle, 3000);

    this.deps.onStatusBarUpdate?.();
    this.deps.statusBar.setMessage(`${t('messages.folderOpened')}: ${result.rootName}`);
  }

  /**
   * フォルダからスクリーンショットを読み込む
   */
  private async loadScreenshotsFromFolder(
    rootHandle: FileSystemDirectoryHandle
  ): Promise<{ screenshots: VerifyScreenshot[]; startTimestamp?: number } | null> {
    try {
      // screenshots フォルダを取得
      const screenshotsFolderHandle = await rootHandle.getDirectoryHandle('screenshots');

      // manifest.json を読み込む
      const manifestHandle = await screenshotsFolderHandle.getFileHandle('manifest.json');
      const manifestFile = await manifestHandle.getFile();
      const manifestText = await manifestFile.text();
      const manifest = JSON.parse(manifestText) as ScreenshotManifest;

      // ScreenshotServiceを作成してスクリーンショットを読み込む
      const screenshotService = new ScreenshotService();
      const screenshots = await screenshotService.loadFromFolder(screenshotsFolderHandle, manifest);

      // startTimestampを計算（最初のスクリーンショットのタイムスタンプから）
      let startTimestamp: number | undefined;
      if (screenshots.length > 0) {
        const firstScreenshot = screenshots.reduce((min, s) => (s.timestamp < min.timestamp ? s : min), screenshots[0]);
        // エクスポート時刻からtimestampを引いてstartTimestampを計算
        const exportedAt = new Date(manifest.exportedAt).getTime();
        const lastTimestamp = screenshots.reduce((max, s) => Math.max(max, s.timestamp), 0);
        startTimestamp = exportedAt - lastTimestamp;
      }

      // サービスを保持し、UIコンポーネントを更新
      this.deps.onScreenshotServiceUpdate?.(screenshotService);

      return { screenshots, startTimestamp };
    } catch {
      // screenshots フォルダが存在しない場合
      return null;
    }
  }

  /**
   * FileSystemFileHandle からファイルを処理
   */
  private async processFileFromHandle(
    fileEntry: FSAccessFileEntry,
    folderMap: Map<string, string>,
    folderScreenshots?: VerifyScreenshot[],
    folderStartTimestamp?: number
  ): Promise<void> {
    const filename = fileEntry.name;

    // 隠しファイル（.で始まるファイル）はスキップ
    if (filename.startsWith('.')) return;

    const parentPath = fileEntry.path.split('/').slice(0, -1).join('/');
    const folderId = folderMap.get(parentPath);

    // 画像ファイルかどうかを判定
    const isImage = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(filename);

    // screenshots フォルダ内のファイルを特別処理
    if (fileEntry.path.startsWith('screenshots/')) {
      if (isImage) {
        // 画像ファイルをファイル一覧に追加（クリックでプレビュー表示）
        try {
          const file = await fileEntry.handle.getFile();
          const blob = new Blob([await file.arrayBuffer()], { type: file.type });
          this.deps.addImageFile({
            filename,
            type: 'image',
            language: 'image',
            rawData: '',
            relativePath: fileEntry.path,
            imageBlob: blob,
          }, folderId);
        } catch (error) {
          console.error('Error loading image:', fileEntry.path, error);
        }
        return;
      }
      // manifest.json やその他のテキストファイルは通常処理
    }

    try {
      const result = await this.deps.fileProcessor.processFromHandle(
        fileEntry.handle,
        fileEntry.path
      );

      if (!result.success) {
        return;
      }

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          // フォルダからスクリーンショットが読み込まれている場合は渡す
          this.deps.addFileToVerification(
            fileData.filename,
            fileData.rawData,
            folderId,
            fileData.relativePath,
            folderScreenshots,
            folderStartTimestamp
          );
        } else if (fileData.type === 'image') {
          this.deps.addImageFile(fileData, folderId);
        } else {
          this.deps.addPlaintextFile(fileData, folderId);
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
    const folderId = this.deps.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId ?? undefined;

    try {
      const result = await this.deps.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success) return;

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          this.deps.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath);
        } else {
          this.deps.addPlaintextFile(fileData, folderId);
        }
      }

      this.deps.statusBar.setMessage(`${t('messages.fileAdded')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing added file:', error);
    }
  }

  /**
   * 外部でファイルが変更された時の処理
   */
  private async handleExternalFileModified(file: FSAccessFileEntry): Promise<void> {
    const existingFileId = this.deps.sidebar.getFileIdByPath(file.path);
    if (!existingFileId) return;

    try {
      const result = await this.deps.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success || result.files.length === 0) return;

      const fileData = result.files[0];
      if (!fileData) return;

      const tabState = this.deps.tabManager.getTab(existingFileId);

      if (tabState) {
        // 既存のタブ状態を更新
        if (fileData.type === 'proof') {
          // 検証ファイルの場合、再検証
          this.deps.tabManager.updateTab(existingFileId, {
            status: 'pending',
            progress: 0,
            verificationResult: null,
          });
          this.deps.sidebar.updateFileStatus(existingFileId, 'pending');
          this.deps.tabBar.updateTabStatus(existingFileId, 'pending', 0);

          this.deps.verificationQueue.enqueue({
            id: existingFileId,
            filename: fileData.filename,
            rawData: fileData.rawData,
          });
        } else {
          // プレーンテキストの場合、内容を更新
          this.deps.tabManager.updateTab(existingFileId, {
            plaintextContent: fileData.rawData,
          });

          // TODO: アクティブタブなら再表示する仕組みが必要
        }
      }

      this.deps.statusBar.setMessage(`${t('messages.fileUpdated')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing modified file:', error);
    }
  }

  /**
   * 外部でファイルが削除された時の処理
   */
  private handleExternalFileDeleted(path: string): void {
    const fileId = this.deps.sidebar.getFileIdByPath(path);
    if (fileId) {
      this.deps.onFileRemove?.(fileId);
      const filename = path.split('/').pop() ?? path;
      this.deps.statusBar.setMessage(`${t('messages.fileDeleted')}: ${filename}`);
    }
  }

  /**
   * 外部でフォルダが追加された時の処理
   */
  private handleExternalFolderAdded(path: string, name: string): void {
    const parentPath = path.split('/').slice(0, -1).join('/');
    const parentId = this.deps.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId;
    const depth = path.split('/').length;

    const folder: HierarchicalFolder = {
      id: this.deps.generateId(),
      name,
      path,
      parentId,
      expanded: false,
      depth,
      sourceType: 'fsaccess',
    };

    this.deps.sidebar.addHierarchicalFolder(folder);
    this.deps.statusBar.setMessage(`${t('messages.folderAdded')}: ${name}`);
  }

  /**
   * 外部でフォルダが削除された時の処理
   */
  private handleExternalFolderDeleted(path: string): void {
    this.deps.sidebar.removeFolderByPath(path);
    const folderName = path.split('/').pop() ?? path;
    this.deps.statusBar.setMessage(`${t('messages.folderDeleted')}: ${folderName}`);
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
          <h3>${t('errors.browserNotSupported')}</h3>
        </div>
        <div class="modal-body">
          <p>${t('errors.browserNotSupportedDesc')}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()">
            ${t('common.close')}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
  }

  /**
   * 監視中のルートフォルダIDを取得
   */
  getWatchedRootFolderId(): string | null {
    return this.watchedRootFolderId;
  }
}
