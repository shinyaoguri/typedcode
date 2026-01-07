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

    // ZIPファイルを階層的に処理
    if (filename.endsWith('.zip')) {
      await this.processZipWithinFolder(
        fileEntry,
        parentPath,
        folderId,
        folderMap,
        folderScreenshots,
        folderStartTimestamp
      );
      return;
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

    // ZIPファイルを階層的に処理
    if (file.name.endsWith('.zip')) {
      const folderMap = this.buildFolderMapFromSidebar();
      await this.processZipWithinFolder(file, parentPath, folderId, folderMap);
      return;
    }

    try {
      const result = await this.deps.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success) return;

      for (const fileData of result.files) {
        if (fileData.type === 'proof') {
          this.deps.addFileToVerification(fileData.filename, fileData.rawData, folderId, fileData.relativePath);
        } else if (fileData.type === 'image') {
          this.deps.addImageFile(fileData, folderId);
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
   * フォルダ内のZIPファイルを階層的に処理
   */
  private async processZipWithinFolder(
    fileEntry: FSAccessFileEntry,
    parentPath: string,
    parentFolderId: string | undefined,
    folderMap: Map<string, string>,
    folderScreenshots?: VerifyScreenshot[],
    folderStartTimestamp?: number
  ): Promise<void> {
    const file = await fileEntry.handle.getFile();
    const result = await this.deps.fileProcessor.process(file);

    if (!result.success) {
      console.error('[FolderController] Failed to process ZIP:', result.error);
      return;
    }

    // ZIPファイル名から拡張子を除去してフォルダ名を作成
    const zipFolderName = fileEntry.name.replace(/\.zip$/i, '');

    // 階層内でのZIPフォルダのフルパスを計算
    const zipFolderPath = parentPath ? `${parentPath}/${zipFolderName}` : zipFolderName;

    // ZIPフォルダを親フォルダの子として作成
    const zipFolderId = this.deps.generateId();
    const zipFolder: HierarchicalFolder = {
      id: zipFolderId,
      name: zipFolderName,
      path: zipFolderPath,
      parentId: parentFolderId ?? null,
      expanded: true,
      depth: zipFolderPath.split('/').length,
      sourceType: 'zip',
    };

    this.deps.sidebar.addHierarchicalFolder(zipFolder);
    folderMap.set(zipFolderPath, zipFolderId);

    // ZIP内のフォルダ構造を作成
    if (result.folderPaths) {
      const sortedPaths = result.folderPaths.sort((a, b) => a.localeCompare(b));

      for (const internalPath of sortedPaths) {
        const fullPath = `${zipFolderPath}/${internalPath}`;
        const parts = fullPath.split('/');
        const folderName = parts[parts.length - 1];
        const folderParentPath = parts.slice(0, -1).join('/');
        const folderParentId = folderMap.get(folderParentPath) ?? zipFolderId;
        const depth = parts.length;

        // screenshotsフォルダはデフォルトで閉じた状態
        const isScreenshotsFolder = folderName === 'screenshots' || internalPath.startsWith('screenshots/');
        const expanded = isScreenshotsFolder ? false : depth <= 2;

        const subFolder: HierarchicalFolder = {
          id: this.deps.generateId(),
          name: folderName,
          path: fullPath,
          parentId: folderParentId,
          expanded,
          depth,
          sourceType: 'zip',
        };

        this.deps.sidebar.addHierarchicalFolder(subFolder);
        folderMap.set(fullPath, subFolder.id);
      }
    }

    // ZIPからスクリーンショットを読み込む
    let zipScreenshots = folderScreenshots;
    let zipStartTimestamp = folderStartTimestamp;

    if (result.screenshots && result.screenshots.length > 0) {
      zipScreenshots = result.screenshots;
      zipStartTimestamp = result.startTimestamp;

      if (result.screenshotService) {
        this.deps.onScreenshotServiceUpdate?.(result.screenshotService);
      }
    }

    // ZIPからファイルを処理
    for (const fileData of result.files) {
      // 階層内でのフルパスを計算
      const fullRelativePath = fileData.relativePath
        ? `${zipFolderPath}/${fileData.relativePath}`
        : `${zipFolderPath}/${fileData.filename}`;

      // 親フォルダIDを検索
      const fileParts = fullRelativePath.split('/');
      const fileParentPath = fileParts.slice(0, -1).join('/');
      const fileFolderId = folderMap.get(fileParentPath) ?? zipFolderId;

      if (fileData.type === 'proof') {
        this.deps.addFileToVerification(
          fileData.filename,
          fileData.rawData,
          fileFolderId,
          fullRelativePath,
          zipScreenshots,
          zipStartTimestamp
        );
      } else if (fileData.type === 'image') {
        this.deps.addImageFile({ ...fileData, relativePath: fullRelativePath }, fileFolderId);
      } else {
        this.deps.addPlaintextFile({ ...fileData, relativePath: fullRelativePath }, fileFolderId);
      }
    }

    this.deps.statusBar.setMessage(`${t('messages.folderOpened')}: ${zipFolderName}`);
  }

  /**
   * 既存のサイドバー状態からfolderMapを構築
   */
  private buildFolderMapFromSidebar(): Map<string, string> {
    const folderMap = new Map<string, string>();

    // ルートフォルダ
    if (this.watchedRootFolderId) {
      folderMap.set('', this.watchedRootFolderId);
    }

    // サイドバーの全フォルダからpath -> idマッピングを構築
    const folders = this.deps.sidebar.getAllFolders();
    for (const folder of folders) {
      if (folder.path !== undefined) {
        folderMap.set(folder.path, folder.id);
      }
    }

    return folderMap;
  }

  /**
   * 監視中のルートフォルダIDを取得
   */
  getWatchedRootFolderId(): string | null {
    return this.watchedRootFolderId;
  }
}
