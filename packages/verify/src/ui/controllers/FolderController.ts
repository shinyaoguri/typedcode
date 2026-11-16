/**
 * FolderController - フォルダ同期を担当するコントローラー
 */
import { FileSystemAccessService } from '../../services/FileSystemAccessService';
import { FolderSyncManager } from '../../services/FolderSyncManager';
import type { ScreenshotService } from '../../services/ScreenshotService';
import { collectFolderChainImageHashes, loadFolderScreenshots } from '../../services/folderScreenshotLoader';
import type { FileProcessor, ParsedFileData } from '../../services/FileProcessor';
import type { ContainerInput } from './FileController';
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

/**
 * 変わるとフォルダのスクショの判定が変わりうるファイルか (#703)。`screenshots/` 配下 (画像・manifest) と、
 * チェーン側の imageHash 集合の材料になる proof 候補 (`collectFolderChainImageHashes` が読む `*.json`)。
 */
function affectsFolderScreenshots(path: string): boolean {
  if (path.startsWith('screenshots/')) return true;
  const name = path.split('/').pop() ?? path;
  return !name.startsWith('.') && name.toLowerCase().endsWith('.json');
}

/** スクショの判定 (読み直しで変わったか) の比較に使う値。画像の中身は判定 (verified / tampered) に表れる */
function screenshotVerdicts(screenshots: readonly VerifyScreenshot[]): string {
  return JSON.stringify(
    screenshots.map((s) => [s.filename, s.imageHash, s.eventSequence, s.timestamp, s.verified, s.missing, s.tampered])
  );
}

/** 監視中のフォルダのスクショ (proof のスクショ検証の入力)。フォルダを開いたとき・監視で変わったときに読む */
interface FolderScreenshots extends ContainerInput {
  rootHandle: FileSystemDirectoryHandle;
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
  /**
   * 外部で変更されたファイルを、同じタブ ID で取り込み直す (#695)。`container` を渡すと proof のスクショ・
   * 記録開始時刻をそれに差し替える (フォルダの `screenshots/` が変わったとき。#703)
   */
  replaceFile: (tabId: string, fileData: ParsedFileData, container?: ContainerInput) => void;
  /** 読み込んだファイルが揃ったところで、同梱ソースと proof.content を照合する (#293) */
  settleSubmission: () => void;
  onScreenshotServiceUpdate?: (service: ScreenshotService) => void;
  /**
   * ステータスバーを今の状態で出し直す。`message` は操作の知らせ (フォルダを開いた等) で、集約 (data-proof-*) を
   * 出せるときは集約が優先される (#683。メッセージで集約を消すと、出し直す契機が来ないことがある)
   */
  onStatusBarUpdate?: (message?: string) => void;
  onFileRemove?: (id: string) => void;
}

export class FolderController {
  private deps: FolderControllerDependencies;
  private fsAccessService: FileSystemAccessService;
  private syncManager: FolderSyncManager;
  private watchedRootFolderId: string | null = null;

  /** 監視中のフォルダのスクショ (#703)。フォルダを開いていなければ null */
  private folderScreenshots: FolderScreenshots | null = null;
  /** フォルダのスクショを渡した proof の FSA パス。スクショが変わったらこれらを取り込み直す (#703) */
  private screenshotProofPaths = new Set<string>();
  /** スクショの読み直しの世代。フォルダを開き直す・次の読み直しを予約すると、古い読み直しの結果を捨てる */
  private screenshotGeneration = 0;
  /** 予約済みの読み直し (同じ走査の通知を 1 回にまとめる)。`force` は screenshots/ 自体が変わったか */
  private pendingScreenshotResync: { force: boolean } | null = null;
  /** 最後に予約した読み直し */
  private screenshotResync: Promise<void> = Promise.resolve();

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
    await this.openFolder(handle);
  }

  /**
   * 選んだフォルダを読み込み、監視を始める
   */
  async openFolder(handle: FileSystemDirectoryHandle): Promise<void> {
    // 既存の監視を停止
    this.syncManager.stopWatching();
    // 前のフォルダのスクショの読み直しが遅れて終わっても、こちらに当てない
    this.screenshotGeneration++;
    this.folderScreenshots = null;
    this.screenshotProofPaths.clear();

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
    this.folderScreenshots = {
      rootHandle: handle,
      screenshots: folderScreenshots,
      startTimestamp: folderStartTimestamp,
    };

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

    this.notify(`${t('messages.folderOpened')}: ${result.rootName}`);
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
          // フォルダのスクショが変わったら取り込み直す (#703)
          if (folderScreenshots) this.screenshotProofPaths.add(fileEntry.path);
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
    if (affectsFolderScreenshots(file.path)) this.scheduleScreenshotResync(file.path);
    const parentPath = file.path.split('/').slice(0, -1).join('/');
    const folderId = this.deps.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId ?? undefined;

    // screenshots/ の画像は初回取り込みと同じく画像タブにする (FileProcessor に回すと平文で読まれる)
    if (isScreenshotImage(file.path)) {
      try {
        this.deps.addImageFile(await readScreenshotImage(file), folderId);
        this.notify(`${t('messages.fileAdded')}: ${file.name}`);
      } catch (error) {
        console.error('Error loading added image:', file.path, error);
      }
      return;
    }

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
          // フォルダはコンテナなので、スクショが無くても未検査 (undefined) ではなく 0 枚として渡す (不変条件 8。#703)
          this.screenshotProofPaths.add(file.path);
          this.deps.addFileToVerification(
            fileData.filename,
            fileData.rawData,
            folderId,
            fileData.relativePath,
            this.folderScreenshots?.screenshots ?? [],
            this.folderScreenshots?.startTimestamp
          );
        } else if (fileData.type === 'image') {
          this.deps.addImageFile(fileData, folderId);
        } else {
          this.deps.addPlaintextFile(fileData, folderId);
        }
      }

      this.deps.settleSubmission();
      this.notify(`${t('messages.fileAdded')}: ${file.name}`);
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
    if (affectsFolderScreenshots(file.path)) this.scheduleScreenshotResync(file.path);
    const existingFileId = this.deps.sidebar.getFileIdByPath(file.path);
    if (!existingFileId) return;

    try {
      // 読み方は初回取り込み (processFileFromHandle) と同じ: screenshots/ の画像は Blob、それ以外は FileProcessor
      const fileData = isScreenshotImage(file.path)
        ? await readScreenshotImage(file)
        : (await this.deps.fileProcessor.processFromHandle(file.handle, file.path)).files[0];
      if (!fileData) return;

      this.deps.replaceFile(existingFileId, fileData);
      this.notify(`${t('messages.fileUpdated')}: ${file.name}`);
    } catch (error) {
      console.error('Error processing modified file:', error);
    }
  }

  /**
   * 外部でファイルが削除された時の処理
   */
  private handleExternalFileDeleted(path: string): void {
    this.screenshotProofPaths.delete(path);
    if (affectsFolderScreenshots(path)) this.scheduleScreenshotResync(path);
    const fileId = this.deps.sidebar.getFileIdByPath(path);
    if (fileId) {
      this.deps.onFileRemove?.(fileId);
      const filename = path.split('/').pop() ?? path;
      this.notify(`${t('messages.fileDeleted')}: ${filename}`);
    }
  }

  /**
   * フォルダのスクショの読み直しを予約する (#703)。監視の 1 回の走査は通知を同期的に続けて出すので、
   * 次のマイクロタスクで 1 回だけ読み直せば、同じ走査で複数のファイルが変わっても proof の取り込み直しは
   * proof ごとに 1 回で済む。
   */
  private scheduleScreenshotResync(path: string): void {
    if (!this.folderScreenshots) return;
    const force = path.startsWith('screenshots/');
    if (this.pendingScreenshotResync) {
      this.pendingScreenshotResync.force ||= force;
      return;
    }
    const pending = { force };
    this.pendingScreenshotResync = pending;
    const generation = ++this.screenshotGeneration;
    this.screenshotResync = Promise.resolve().then(() => {
      this.pendingScreenshotResync = null;
      return this.resyncFolderScreenshots(generation, pending.force);
    });
  }

  /**
   * フォルダのスクショを読み直し、フォルダのスクショを渡した proof を同じタブ ID で取り込み直す (#703)。
   *
   * 読み方は開いたときと同じ (チェーン側の imageHash 集合を集め直してから `loadFolderScreenshots`)。
   * proof はディスクから読み直して `replaceFile` に渡す (#695 と同じ経路。本文・照合・検証を新しい内容の
   * 1 スナップショットに揃える)。`screenshots/` 自体が変わっていない (proof だけが変わった) ときは、判定が
   * 変わったときだけ取り込み直す。
   */
  private async resyncFolderScreenshots(generation: number, force: boolean): Promise<void> {
    const current = this.folderScreenshots;
    const rootFolderId = this.watchedRootFolderId;
    if (!current || generation !== this.screenshotGeneration) return;
    try {
      const listing = await this.fsAccessService.readDirectoryRecursive(current.rootHandle);
      if (!listing.success) return;
      const chainImageHashes = await collectFolderChainImageHashes(listing.files);
      const loaded = await loadFolderScreenshots(current.rootHandle, chainImageHashes);
      // 読んでいる間に次の読み直しが予約された・別のフォルダを開いた
      if (generation !== this.screenshotGeneration) return;

      const changed =
        screenshotVerdicts(current.screenshots) !== screenshotVerdicts(loaded.screenshots) ||
        current.startTimestamp !== loaded.startTimestamp;
      this.folderScreenshots = {
        rootHandle: current.rootHandle,
        screenshots: loaded.screenshots,
        startTimestamp: loaded.startTimestamp,
      };
      if (loaded.screenshotService) this.deps.onScreenshotServiceUpdate?.(loaded.screenshotService);
      if (!force && !changed) return;

      const entries = new Map(listing.files.map((entry) => [entry.path, entry]));
      for (const path of [...this.screenshotProofPaths]) {
        const tabId = this.deps.sidebar.getFileIdByPath(path);
        const entry = entries.get(path);
        if (!tabId || !entry) continue;
        const fileData = (await this.deps.fileProcessor.processFromHandle(entry.handle, entry.path)).files[0];
        // 待っている間に別のフォルダを開いたらやめる。次の読み直しが始まっていても、ここではやめずに最新の
        // スクショを渡す (途中でやめると、判定が同じと見た次の読み直しが残りの proof を取り込み直さない)
        const latest = this.folderScreenshots;
        if (!latest || this.watchedRootFolderId !== rootFolderId) return;
        if (!fileData) continue;
        this.deps.replaceFile(tabId, fileData, {
          screenshots: latest.screenshots,
          startTimestamp: latest.startTimestamp,
        });
      }
    } catch (error) {
      console.error('Error reloading folder screenshots:', error);
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
    this.notify(`${t('messages.folderAdded')}: ${name}`);
  }

  /**
   * 外部でフォルダが削除された時の処理
   */
  private handleExternalFolderDeleted(path: string): void {
    this.deps.sidebar.removeFolderByPath(path);
    const folderName = path.split('/').pop() ?? path;
    this.notify(`${t('messages.folderDeleted')}: ${folderName}`);
  }

  /**
   * 操作の知らせを出す。集約を消さないよう、ステータスバーの表示はいつも onStatusBarUpdate に決めさせる (#683)
   */
  private notify(message: string): void {
    if (this.deps.onStatusBarUpdate) this.deps.onStatusBarUpdate(message);
    else this.deps.statusBar.setMessage(message);
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
    this.notify(`${t('messages.folderOpened')}: ${zipFolderName}`);
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

  /** 最後に予約したスクショの読み直し (#703) が終わるのを待つ */
  whenScreenshotsResynced(): Promise<void> {
    return this.screenshotResync;
  }

  /**
   * 監視中のルートフォルダIDを取得
   */
  getWatchedRootFolderId(): string | null {
    return this.watchedRootFolderId;
  }
}
