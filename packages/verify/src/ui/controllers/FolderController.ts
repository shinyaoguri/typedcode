/**
 * FolderController - フォルダ同期を担当するコントローラー
 */
import { FileSystemAccessService } from '../../services/FileSystemAccessService';
import { FolderSyncManager } from '../../services/FolderSyncManager';
import type { ScreenshotService } from '../../services/ScreenshotService';
import { collectFolderChainImageHashes, loadFolderScreenshots } from '../../services/folderScreenshotLoader';
import type { FileProcessor, ParsedFileData } from '../../services/FileProcessor';
import type { Sidebar } from '../Sidebar';
import type { StatusBarUI } from '../StatusBarUI';
import type { FSAccessFileEntry, HierarchicalFolder, VerifyScreenshot } from '../../types';
import { t } from '../../i18n/index';

/** フォルダの screenshots/ 配下の画像か (画像タブとして並べる。それ以外は FileProcessor で読む) */
function isScreenshotImage(path: string): boolean {
  return path.startsWith('screenshots/') && /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(path);
}

/** screenshots/ 配下の画像を、画像タブ用の ParsedFileData にする。 */
async function readScreenshotImage(fileEntry: FSAccessFileEntry): Promise<ParsedFileData> {
  const file = await fileEntry.handle.getFile();
  return {
    filename: fileEntry.name,
    type: 'image',
    language: 'image',
    rawData: '',
    relativePath: fileEntry.path,
    imageBlob: new Blob([await file.arrayBuffer()], { type: file.type }),
  };
}

export interface FolderControllerDependencies {
  fileProcessor: FileProcessor;
  sidebar: Sidebar;
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
  /** 外部で変更されたファイルを、同じタブ ID で取り込み直す (#695) */
  replaceFile: (tabId: string, fileData: ParsedFileData) => void;
  /** 読み込んだファイルが揃ったところで、同梱ソースと proof.content を照合する (#293) */
  settleSubmission: () => void;
  onScreenshotServiceUpdate?: (service: ScreenshotService) => void;
  onStatusBarUpdate?: () => void;
  onFileRemove?: (id: string) => void;
}

export class FolderController {
  private deps: FolderControllerDependencies;
  private fsAccessService: FileSystemAccessService;
  private syncManager: FolderSyncManager;
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

    // スクリーンショットを読み込む。フォルダはエクスポート ZIP を展開したものと同じコンテナなので、
    // screenshots/ が無くても「未検査」ではなく **0 枚** として扱う (剥ぎ取りを chainOnly で検出させる #213)。
    // チェーン裏付け (#212) のため、先にフォルダ内の proof から imageHash 集合を集めて渡す。
    const chainImageHashes = await collectFolderChainImageHashes(result.files);
    const loadResult = await loadFolderScreenshots(handle, chainImageHashes);
    const folderScreenshots: VerifyScreenshot[] = loadResult.screenshots;
    const folderStartTimestamp = loadResult.startTimestamp;
    console.log(`[FolderController] Loaded ${folderScreenshots.length} screenshots from folder`);
    if (loadResult.screenshotService) {
      this.deps.onScreenshotServiceUpdate?.(loadResult.screenshotService);
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
    const sortedFolders = result.folders.sort((a, b) => a.path.localeCompare(b.path));

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
    this.deps.settleSubmission();

    // 監視を開始
    await this.syncManager.startWatching(handle, 3000);

    this.deps.onStatusBarUpdate?.();
    this.deps.statusBar.setMessage(`${t('messages.folderOpened')}: ${result.rootName}`);
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

    // screenshots フォルダ内の画像は、ファイル一覧に画像として追加する (クリックでプレビュー表示)。
    // manifest.json やその他のテキストファイルは通常処理
    if (isScreenshotImage(fileEntry.path)) {
      try {
        this.deps.addImageFile(await readScreenshotImage(fileEntry), folderId);
      } catch (error) {
        console.error('Error loading image:', fileEntry.path, error);
      }
      return;
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
      const result = await this.deps.fileProcessor.processFromHandle(fileEntry.handle, fileEntry.path);

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

      this.deps.settleSubmission();
      this.deps.statusBar.setMessage(`${t('messages.fileAdded')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing added file:', error);
    }
  }

  /**
   * 外部でファイルが変更された時の処理
   *
   * 同じタブ ID での取り込み直し (#695)。状態の組み立ては FileController (`replaceFile`) が初回取り込みと
   * 同じ関数で行う。ここで tabManager / 検証キューを直接触って状態を部分的に作り直さない (古い本文と
   * 新しい検証結果が混ざる)。
   */
  private async handleExternalFileModified(file: FSAccessFileEntry): Promise<void> {
    const existingFileId = this.deps.sidebar.getFileIdByPath(file.path);
    if (!existingFileId) return;

    try {
      // 読み方は初回取り込み (processFileFromHandle) と同じ: screenshots/ の画像は Blob、それ以外は FileProcessor
      const fileData = isScreenshotImage(file.path)
        ? await readScreenshotImage(file)
        : (await this.deps.fileProcessor.processFromHandle(file.handle, file.path)).files[0];
      if (!fileData) return;

      this.deps.replaceFile(existingFileId, fileData);
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
          name: folderName ?? '',
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

    this.deps.settleSubmission();
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
