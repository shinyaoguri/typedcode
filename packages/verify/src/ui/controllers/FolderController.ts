/**
 * FolderController - フォルダ同期を担当するコントローラー
 */
import { FileSystemAccessService } from '../../services/FileSystemAccessService';
import { FolderSyncManager } from '../../services/FolderSyncManager';
import type { ScreenshotService } from '../../services/ScreenshotService';
import {
  collectFolderChainImageHashes,
  isZipInFolder,
  loadFolderScreenshots,
} from '../../services/folderScreenshotLoader';
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
  // ZIP の proof も集合の材料 (#786)。ZIP と見なす規則は集合づくりと同じ isZipInFolder (#834)
  return !name.startsWith('.') && (name.toLowerCase().endsWith('.json') || isZipInFolder(name));
}

/** スクショの判定 (読み直しで変わったか) の比較に使う値。画像の中身は判定 (verified / tampered) に表れる */
function screenshotVerdicts(screenshots: readonly VerifyScreenshot[]): string {
  return JSON.stringify(
    screenshots.map((s) => [s.filename, s.imageHash, s.eventSequence, s.timestamp, s.verified, s.missing, s.tampered])
  );
}

/**
 * 監視中のフォルダのスクショ (proof のスクショ検証の入力)。フォルダを開いたとき・監視で変わったときに読む。
 * `screenshots` が undefined = 開いたときに読み取りに失敗してまだ読めていない (#773)。proof には未検査として渡し、
 * 「0 枚」(剥ぎ取り疑い) や欠損で確定しない。読み直しの求めを残し、読めたら取り込み直す
 */
interface FolderScreenshots {
  rootHandle: FileSystemDirectoryHandle;
  screenshots: VerifyScreenshot[] | undefined;
  startTimestamp?: number;
}

/** 読み込みに失敗した監視の変更 (#773)。次に監視の走査が成功した回にやり直す */
interface FailedChange {
  entry: FSAccessFileEntry;
  /** 追加 (まだタブが無い) か変更 (タブを取り込み直す) か */
  kind: 'added' | 'modified';
  error: unknown;
}

/**
 * 監視の変更の読み込み 1 本 (#787)。同じパスの読み込みが重なったら、最後に始めたものだけが結果を反映する
 */
interface ChangeLoad {
  kind: FailedChange['kind'];
  /** この読み込みがまだそのパスの最新か (読み終えた後・タブや一覧を書き換える直前に見る) */
  isCurrent: () => boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /** 監視の走査が失敗し続けている間 true。失敗の表示は失敗に入った回だけ出す (#699) */
  private syncFailing = false;

  /** 監視中のフォルダのスクショ (#703)。フォルダを開いていなければ null */
  private folderScreenshots: FolderScreenshots | null = null;
  /** フォルダのスクショを渡した proof の FSA パス。スクショが変わったらこれらを取り込み直す (#703) */
  private screenshotProofPaths = new Set<string>();
  /**
   * screenshotProofPaths のうち、フォルダのスクショへ落とした ZIP の proof (タブのパス → ZIP から読んだ内容。#742)。
   * ディスク上の単独のファイルではないので、取り込み直しはディスクではなくここから行う
   */
  private zipScreenshotProofs = new Map<string, ParsedFileData>();
  /** スクショの読み直しの世代。フォルダを開き直す・次の読み直しを予約すると、古い読み直しの結果を捨てる */
  private screenshotGeneration = 0;
  /** 予約したがまだ始まっていない読み直しがあるか (同じ走査の通知を 1 回にまとめる) */
  private pendingScreenshotResync = false;
  /** 走っている読み直しの数 (監視の周期でのやり直しを、走っている間は重ねない) */
  private runningScreenshotResyncs = 0;
  /**
   * まだ済んでいない読み直しの求め。読み直しが最後まで済んだときだけ消す。読み取りに失敗した・新しい読み直しに
   * 譲った読み直しは求めを残し、次に監視の走査が成功したときにやり直す (変化の通知は 1 回しか来ない)。
   * `force` は screenshots/ 自体が変わったか (判定が同じでも proof を取り込み直す)
   */
  private screenshotResyncDemand: { force: boolean } | null = null;
  /** 読み直しが読み取りに失敗し続けている間 true。失敗の表示は失敗に入った回だけ出す (#699 と同じ流儀) */
  private screenshotResyncFailing = false;
  /** 最後に予約した読み直し */
  private screenshotResync: Promise<void> = Promise.resolve();
  /**
   * 読み込みに失敗した変更 (パス → 変更)。監視は変更を通知済みとして記録するので、ここで覚えて次に走査が成功した
   * 回にやり直す (#773。スクショの読み直しの求めと同じ形)。やり直しが成功したら消し、その間に消えたファイルは
   * やり直さない (削除の通知で消す)
   */
  private failedChanges = new Map<string, FailedChange>();
  /** 変更の読み込みが失敗し続けている間 true。失敗の表示は失敗に入った回だけ出す (#699 と同じ流儀) */
  private changeLoadFailing = false;
  /**
   * 走っている変更の読み込み (パス → 最後に始めた読み込み。#787)。同じパスの通知・やり直しは直列ではないので、
   * 先に始めた読み込み (古い内容) が後から終わっても結果を捨てる (スクショの読み直しの世代と同じ形)。
   * 読み込みが終わったら消し、削除の通知・フォルダを開き直すときにも消す (走っている読み込みは捨てられる)
   */
  private changeLoads = new Map<string, ChangeLoad>();
  /**
   * フォルダ内の ZIP (FSA パス) → その ZIP から開いたフォルダ行とタブのパス (#785)。ZIP のタブは ZIP のフォルダ
   * (`sub.zip` なら `sub/…`) の下にあり ZIP 自体のパスでは引けないので、ZIP が変わった・消えたときはここから引く
   * (パスの接頭辞では引かない。`sub.zip` と `sub2.zip`、同名の実フォルダを取り違える)
   */
  private zipContents = new Map<string, { folderId: string; tabPaths: string[] }>();

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
      onSyncComplete: () => this.handleSyncComplete(),
      onSyncError: (error) => this.handleSyncError(error),
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
    this.syncFailing = false;
    // 前のフォルダのスクショの読み直しが遅れて終わっても、こちらに当てない
    this.screenshotGeneration++;
    this.folderScreenshots = null;
    this.screenshotProofPaths.clear();
    this.zipScreenshotProofs.clear();
    this.screenshotResyncDemand = null;
    this.screenshotResyncFailing = false;
    this.failedChanges.clear();
    this.changeLoadFailing = false;
    this.changeLoads.clear();
    this.zipContents.clear();

    // ディレクトリを読み取り。まず個々のファイルの読み取りの失敗も失敗にする strict で読む (#773)。読めない
    // ファイルがあれば、それを飛ばした一覧で開く (読めないファイル 1 つでフォルダごと開けなくしない)。飛ばした
    // ファイルは監視の基準 (= この一覧。#734) に無いので、次に監視の走査が成功した回に追加として入る
    const strictListing = await this.fsAccessService.readDirectoryRecursive(handle, '', { strict: true });
    const result = strictListing.success ? strictListing : await this.fsAccessService.readDirectoryRecursive(handle);
    if (!result.success) {
      this.deps.statusBar.setError(result.error ?? t('errors.folderReadError'));
      return;
    }
    // 一覧が不完全 (飛ばしたファイルがある) なら、飛ばした proof がチェーン側の imageHash 集合から抜けている
    const listingError = strictListing.success ? null : new Error(strictListing.error ?? 'folder read failed');

    // スクリーンショットを読み込む。フォルダはエクスポート ZIP を展開したものと同じコンテナなので、
    // screenshots/ が無くても「未検査」ではなく **0 枚** として扱う (剥ぎ取りを chainOnly で検出させる #213)。
    // チェーン裏付け (#212) のため、先にフォルダ内の proof から imageHash 集合を集めて渡す。
    // 読みは監視中の読み直し (#703) と同じく strict: 無い (`NotFoundError`) 以外の読み取りの失敗では 0 枚・欠損と
    // 確定せず、まだ読めていない (proof には未検査) として読み直しの求めを残す (#773)
    let screenshotReadError: unknown = null;
    try {
      // 一覧が不完全なうちはスクショの判定を確定しない (未検査で渡し、読み直しで揃える)
      if (listingError) throw listingError;
      const chainImageHashes = await collectFolderChainImageHashes(result.files, { strict: true });
      const loadResult = await loadFolderScreenshots(handle, chainImageHashes, { strict: true });
      console.log(`[FolderController] Loaded ${loadResult.screenshots.length} screenshots from folder`);
      if (loadResult.screenshotService) {
        this.deps.onScreenshotServiceUpdate?.(loadResult.screenshotService);
      }
      this.folderScreenshots = {
        rootHandle: handle,
        screenshots: loadResult.screenshots,
        startTimestamp: loadResult.startTimestamp,
      };
    } catch (error) {
      console.error('Error loading folder screenshots:', error);
      screenshotReadError = error;
      this.folderScreenshots = { rootHandle: handle, screenshots: undefined };
      this.screenshotResyncDemand = { force: true };
      this.screenshotResyncFailing = true;
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
      await this.processFileFromHandle(fileEntry, folderMap);
    }
    this.deps.settleSubmission();

    // 監視を開始
    await this.syncManager.startWatching(handle, 3000, result);

    // 読めなかったものがあれば、開いた知らせの代わりに失敗を出す (次に監視の走査が成功した回にやり直す)
    this.changeLoadFailing = this.failedChanges.size > 0;
    const readError = screenshotReadError ?? this.failedChanges.values().next().value?.error;
    if (readError) this.showReadFailure(readError);
    else this.notify(`${t('messages.folderOpened')}: ${result.rootName}`);
  }

  /** フォルダの読み取りに失敗して、変更を反映していないことを知らせる */
  private showReadFailure(error: unknown): void {
    this.deps.statusBar.setError(`${t('errors.folderSyncFailed')}: ${errorMessage(error)}`);
  }

  /**
   * proof に渡すフォルダのスクショ (#703)。フォルダはコンテナなので、スクショが無くても未検査 (undefined) ではなく
   * 0 枚として渡す (不変条件 8)。開いたときに読めなかった間だけ未検査 (#773)
   */
  private folderContainer(): { screenshots: VerifyScreenshot[] | undefined; startTimestamp?: number } {
    if (!this.folderScreenshots) return { screenshots: [] };
    return { screenshots: this.folderScreenshots.screenshots, startTimestamp: this.folderScreenshots.startTimestamp };
  }

  /**
   * FileSystemFileHandle からファイルを処理
   */
  private async processFileFromHandle(fileEntry: FSAccessFileEntry, folderMap: Map<string, string>): Promise<void> {
    // 隠しファイル（.で始まるファイル）はスキップ
    if (fileEntry.name.startsWith('.')) return;

    const parentPath = fileEntry.path.split('/').slice(0, -1).join('/');
    try {
      await this.loadNewFile(fileEntry, folderMap.get(parentPath), folderMap);
    } catch (error) {
      // 読めなかったファイルを黙って飛ばさない。監視で足されたファイルと同じく、次に走査が成功した回にやり直す (#773)
      console.error('Error processing file:', fileEntry.path, error);
      this.failedChanges.set(fileEntry.path, { entry: fileEntry, kind: 'added', error });
    }
  }

  /**
   * 新しいファイル (開いたときのファイル・監視中に足されたファイル) を読み込んでタブにする。読み取りに失敗したら
   * 投げる (呼び出し側がやり直しに回す。#773)。読み方は開いたときも監視中も同じ。`isCurrent` は監視の読み込みの
   * 世代 (#787): 読み終えたときに false なら、同じパスの新しい読み込みに譲って何も足さない
   */
  private async loadNewFile(
    fileEntry: FSAccessFileEntry,
    folderId: string | undefined,
    folderMap: Map<string, string>,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    // screenshots フォルダ内の画像は、ファイル一覧に画像として追加する (クリックでプレビュー表示)。
    // manifest.json やその他のテキストファイルは通常処理 (FileProcessor に回すと平文で読まれる)
    if (isScreenshotImage(fileEntry.path)) {
      const image = await readScreenshotImage(fileEntry);
      if (isCurrent()) this.deps.addImageFile(image, folderId);
      return;
    }

    // ZIPファイルを階層的に処理 (チェーン側の imageHash 集合も同じ規則で ZIP を読む。#786)
    if (isZipInFolder(fileEntry.name)) {
      const parentPath = fileEntry.path.split('/').slice(0, -1).join('/');
      await this.processZipWithinFolder(fileEntry, parentPath, folderId, folderMap, isCurrent);
      return;
    }

    const result = await this.deps.fileProcessor.processFromHandle(fileEntry.handle, fileEntry.path);
    // JSON・平文の success: false は読み取りの失敗 (壊れた JSON は error の proof として success で返る。#702)
    if (!result.success) throw new Error(result.error ?? `cannot read ${fileEntry.path}`);
    // 読んでいる間に同じパスの新しい読み込みが始まった (#787。失敗は呼び出し側が世代を見て捨てる)
    if (!isCurrent()) return;

    for (const fileData of result.files) {
      if (fileData.type === 'proof') {
        // フォルダはコンテナなので、スクショが無くても未検査 (undefined) ではなく 0 枚として渡す (不変条件 8。#703)。
        // スクショは読み込みを待った後のここで引く (待つ前に引くと、その間に終わった読み直しの結果を取り逃す)。
        // 読み直しは folderScreenshots の更新と screenshotProofPaths の写しを同期的に続けて行うので、ここが
        // 読み直しの前なら写しに入って取り込み直され、後なら最新のスクショを受け取る
        const container = this.folderContainer();
        this.screenshotProofPaths.add(fileEntry.path);
        this.deps.addFileToVerification(
          fileData.filename,
          fileData.rawData,
          folderId,
          fileData.relativePath,
          container.screenshots,
          container.startTimestamp
        );
      } else if (fileData.type === 'image') {
        this.deps.addImageFile(fileData, folderId);
      } else {
        this.deps.addPlaintextFile(fileData, folderId);
      }
    }
  }

  /**
   * 監視の走査が読めなかった時の処理 (#699)
   *
   * FolderSyncManager はこの回の差分を確定していない (タブ・検証結果はそのまま)。利用者には
   * 「変更を反映していない」ことだけを知らせる。監視は 3 秒ごとなので、同じ失敗が続いても出し直さない
   * (setError は検証集約の表示と data-proof-* を上書きする)。
   */
  private handleSyncError(error: Error): void {
    console.error('Sync error:', error);
    if (this.syncFailing) return;
    this.syncFailing = true;
    this.deps.statusBar.setError(`${t('errors.folderSyncFailed')}: ${error.message}`);
  }

  /** 走査が最後まで読めた時の処理。失敗の表示を出していたら通常の表示に戻す (#699) */
  private handleSyncComplete(): void {
    // 読み取りに失敗して済んでいないスクショの読み直しは、走査が成功したこの周期でやり直す (#703)
    this.retryScreenshotResync();
    // 読み込みに失敗した変更も同じくやり直す (#773。変化の通知は 1 回しか来ない)
    this.retryFailedChanges();
    if (!this.syncFailing) return;
    this.syncFailing = false;
    this.deps.onStatusBarUpdate?.();
  }

  /**
   * 外部でファイルが追加された時の処理
   */
  private async handleExternalFileAdded(file: FSAccessFileEntry): Promise<void> {
    // 新しい通知が優先する (覚えていた失敗はこの読み込みで置き換わる)
    this.failedChanges.delete(file.path);
    if (affectsFolderScreenshots(file.path)) this.scheduleScreenshotResync(file.path);
    await this.loadChange(file, 'added');
  }

  /** 監視で足されたファイルを読み込む。読み取りに失敗したら投げる */
  private async loadAddedFile(file: FSAccessFileEntry, isCurrent: () => boolean): Promise<void> {
    const parentPath = file.path.split('/').slice(0, -1).join('/');
    const folderId = this.deps.sidebar.getFolderIdByPath(parentPath) ?? this.watchedRootFolderId ?? undefined;
    const isZip = isZipInFolder(file.name);
    await this.loadNewFile(file, folderId, isZip ? this.buildFolderMapFromSidebar() : new Map(), isCurrent);
    // ZIP は processZipWithinFolder が照合と知らせを済ませる。新しい読み込みに譲ったら、そちらが済ませる
    if (isZip || !isCurrent()) return;
    if (!isScreenshotImage(file.path)) this.deps.settleSubmission();
    this.notify(`${t('messages.fileAdded')}: ${file.name}`);
  }

  /**
   * 監視で変わったファイルを読み込む。読み込みに失敗したら覚えておき、次に走査が成功した回にやり直す (#773)。
   * 監視は変更を通知済みとして記録するので、ここで落とすと二度と通知されず、タブが古い内容のまま残る
   */
  private async loadChange(file: FSAccessFileEntry, kind: FailedChange['kind']): Promise<void> {
    // 同じパスの読み込みが重なったら、最後に始めたものだけが結果を反映する (#787)。古い読み込みは成功しても
    // 失敗しても何も確定しない (失敗として覚えない・失敗の表示を解かない)。新しい世代が正
    const load: ChangeLoad = { kind, isCurrent: () => this.changeLoads.get(file.path) === load };
    this.changeLoads.set(file.path, load);
    try {
      if (kind === 'added') await this.loadAddedFile(file, load.isCurrent);
      else await this.loadModifiedFile(file, load.isCurrent);
    } catch (error) {
      console.error(`Error processing ${kind} file:`, file.path, error);
      // 同じパスの新しい読み込みに譲った・削除された・別のフォルダを開いた
      if (!load.isCurrent()) return;
      this.changeLoads.delete(file.path);
      this.failedChanges.set(file.path, { entry: file, kind, error });
      if (!this.changeLoadFailing) {
        this.changeLoadFailing = true;
        this.showReadFailure(error);
      }
      return;
    }
    if (!load.isCurrent()) return;
    this.changeLoads.delete(file.path);
    if (this.changeLoadFailing && this.failedChanges.size === 0) {
      // やり直しが済んだ。ステータスバーは知らせ (notify) が通常の表示に戻している
      this.changeLoadFailing = false;
    }
  }

  /** 読み込みに失敗した変更をやり直す (監視の走査が成功したとき)。 */
  private retryFailedChanges(): void {
    const failed = [...this.failedChanges.values()];
    this.failedChanges.clear();
    for (const change of failed) void this.loadChange(change.entry, change.kind);
  }

  /**
   * 外部でファイルが変更された時の処理
   *
   * 同じタブ ID での取り込み直し (#695)。状態の組み立ては FileController (`replaceFile`) が初回取り込みと
   * 同じ関数で行う。ここで tabManager / 検証キューを直接触って状態を部分的に作り直さない (古い本文と
   * 新しい検証結果が混ざる)。
   */
  private async handleExternalFileModified(file: FSAccessFileEntry): Promise<void> {
    // 足されたときの読み込みに失敗した・まだ読み込み中のファイルはタブが無い。変更の通知でも追加として読み込む
    // (#773 / #787。読み込み中の追加はこの読み込みに譲って結果を捨てる)
    const added =
      this.failedChanges.get(file.path)?.kind === 'added' || this.changeLoads.get(file.path)?.kind === 'added';
    const kind = added ? 'added' : 'modified';
    this.failedChanges.delete(file.path);
    if (affectsFolderScreenshots(file.path)) this.scheduleScreenshotResync(file.path);
    await this.loadChange(file, kind);
  }

  /** 監視で変わったファイルを読み込んで取り込み直す。読み取りに失敗したら投げる */
  private async loadModifiedFile(file: FSAccessFileEntry, isCurrent: () => boolean): Promise<void> {
    // ZIP は開いたときと同じ読み方で取り込み直す (古い配下は processZipWithinFolder が読み終えてから外す。#785)
    if (isZipInFolder(file.name)) {
      await this.loadAddedFile(file, isCurrent);
      return;
    }
    if (!this.deps.sidebar.getFileIdByPath(file.path)) return;

    // 読み方は初回取り込み (loadNewFile) と同じ: screenshots/ の画像は Blob、それ以外は FileProcessor
    let fileData: ParsedFileData | undefined;
    if (isScreenshotImage(file.path)) {
      fileData = await readScreenshotImage(file);
    } else {
      const result = await this.deps.fileProcessor.processFromHandle(file.handle, file.path);
      if (!result.success) throw new Error(result.error ?? `cannot read ${file.path}`);
      fileData = result.files[0];
    }
    // 読んでいる間に同じパスの新しい読み込みが始まった・ファイルが消えた (#787)
    const existingFileId = this.deps.sidebar.getFileIdByPath(file.path);
    if (!fileData || !existingFileId || !isCurrent()) return;

    this.deps.replaceFile(existingFileId, fileData);
    this.notify(`${t('messages.fileUpdated')}: ${file.name}`);
  }

  /**
   * 外部でファイルが削除された時の処理
   */
  private handleExternalFileDeleted(path: string): void {
    // 読み込みに失敗していた変更はやり直さない (削除として扱う。#773)。読み込み中の変更の結果も捨てる (#787)
    this.failedChanges.delete(path);
    this.changeLoads.delete(path);
    this.screenshotProofPaths.delete(path);
    this.zipScreenshotProofs.delete(path);
    if (affectsFolderScreenshots(path)) this.scheduleScreenshotResync(path);
    const filename = path.split('/').pop() ?? path;
    // ZIP から開いたタブとフォルダ行は ZIP のパスでは引けない (#785)
    if (this.removeZipContents(path)) {
      this.notify(`${t('messages.fileDeleted')}: ${filename}`);
      return;
    }
    const fileId = this.deps.sidebar.getFileIdByPath(path);
    if (fileId) {
      this.deps.onFileRemove?.(fileId);
      this.notify(`${t('messages.fileDeleted')}: ${filename}`);
    }
  }

  /**
   * フォルダ内の ZIP から開いたタブとフォルダ行を外す (#785)。フォルダのスクショの読み直しの対象 (#742) からも外す。
   * その ZIP から開いたものが無ければ false
   */
  private removeZipContents(zipPath: string): boolean {
    const contents = this.zipContents.get(zipPath);
    if (!contents) return false;
    this.zipContents.delete(zipPath);
    for (const tabPath of contents.tabPaths) {
      this.screenshotProofPaths.delete(tabPath);
      this.zipScreenshotProofs.delete(tabPath);
    }
    for (const fileId of this.deps.sidebar.getFileIdsInFolderTree(contents.folderId)) {
      this.deps.onFileRemove?.(fileId);
    }
    this.deps.sidebar.removeFolder(contents.folderId);
    return true;
  }

  /**
   * フォルダのスクショの読み直しを予約する (#703)。監視の 1 回の走査は通知を同期的に続けて出すので、
   * 次のマイクロタスクで 1 回だけ読み直せば、同じ走査で複数のファイルが変わっても proof の取り込み直しは
   * proof ごとに 1 回で済む。
   */
  private scheduleScreenshotResync(path: string): void {
    if (!this.folderScreenshots) return;
    const force = path.startsWith('screenshots/') || (this.screenshotResyncDemand?.force ?? false);
    this.screenshotResyncDemand = { force };
    this.startScreenshotResync();
  }

  /** 済んでいない読み直しの求めが残っていて、読み直しが走っていなければ始める (監視の走査が成功したとき)。 */
  private retryScreenshotResync(): void {
    if (!this.screenshotResyncDemand || this.pendingScreenshotResync || this.runningScreenshotResyncs > 0) return;
    this.startScreenshotResync();
  }

  private startScreenshotResync(): void {
    if (this.pendingScreenshotResync) return;
    this.pendingScreenshotResync = true;
    const generation = ++this.screenshotGeneration;
    this.screenshotResync = Promise.resolve().then(() => {
      this.pendingScreenshotResync = false;
      return this.resyncFolderScreenshots(generation);
    });
  }

  /**
   * フォルダのスクショを読み直し、フォルダのスクショを渡した proof を同じタブ ID で取り込み直す (#703)。
   *
   * 読み方は開いたときと同じ (チェーン側の imageHash 集合を集め直してから `loadFolderScreenshots`)。
   * proof はディスクから読み直して `replaceFile` に渡す (#695 と同じ経路。本文・照合・検証を新しい内容の
   * 1 スナップショットに揃える)。`screenshots/` 自体が変わっていない (proof だけが変わった) ときは、判定が
   * 変わったときだけ取り込み直す。
   *
   * 読み取りに失敗したら何も確定しない (#699 と同じ考え方)。読めなかった画像・manifest・proof を「無い」と
   * 見ると、スクショ 0 枚 (剥ぎ取り疑い) や改竄の誤判定を確定してしまう。そのため読みはすべて失敗を伝える形
   * (`strict`) で行い、全部読めてから、スクショの更新と proof の取り込み直しを同期的に続けて行う。
   * 失敗した求めは残り、次に監視の走査が成功したときにやり直す。
   */
  private async resyncFolderScreenshots(generation: number): Promise<void> {
    const current = this.folderScreenshots;
    const demand = this.screenshotResyncDemand;
    const rootFolderId = this.watchedRootFolderId;
    if (!current || !demand || generation !== this.screenshotGeneration) return;
    this.runningScreenshotResyncs++;
    try {
      const listing = await this.fsAccessService.readDirectoryRecursive(current.rootHandle, '', { strict: true });
      if (!listing.success) throw new Error(listing.error ?? 'folder read failed');
      const chainImageHashes = await collectFolderChainImageHashes(listing.files, { strict: true });
      const loaded = await loadFolderScreenshots(current.rootHandle, chainImageHashes, { strict: true });

      // 開いたときに読めなかった (undefined) スクショは、読めたら必ず取り込み直す (#773)
      const changed =
        current.screenshots === undefined ||
        screenshotVerdicts(current.screenshots) !== screenshotVerdicts(loaded.screenshots) ||
        current.startTimestamp !== loaded.startTimestamp;
      // 取り込み直す proof を先にすべて読む。読んでいる間に足された proof も読み、残りが無くなったところで
      // (await を挟まずに) スクショを更新して取り込み直す。足された proof の取り込み口はスクショを待った後で
      // 引くので、ここより後なら新しいスクショを受け取る
      // ZIP の proof ('zip') はタブと内容を確定の時点で引く (#834)。ZIP の取り込み直し (#785) は読み直しと並んで
      // 走り、途中で終わるとタブ ID と内容が入れ替わる。ここで控えると、新しいタブを古いスクショのまま取りこぼす
      const reread = new Map<string, { tabId: string; fileData: ParsedFileData } | 'zip' | null>();
      if (demand.force || changed) {
        const entries = new Map(listing.files.map((entry) => [entry.path, entry]));
        for (;;) {
          const pending = [...this.screenshotProofPaths].filter((path) => !reread.has(path));
          if (pending.length === 0) break;
          for (const path of pending) {
            // フォルダのスクショへ落とした ZIP の proof は、ZIP から読んだ内容で取り込み直す (#742)
            if (this.zipScreenshotProofs.has(path)) {
              reread.set(path, 'zip');
              continue;
            }
            const tabId = this.deps.sidebar.getFileIdByPath(path);
            const entry = entries.get(path) ?? (await this.findFileEntry(current.rootHandle, path));
            if (!tabId || !entry) {
              reread.set(path, null);
              continue;
            }
            const result = await this.deps.fileProcessor.processFromHandle(entry.handle, entry.path);
            if (!result.success) throw new Error(result.error ?? `cannot read ${path}`);
            const fileData = result.files[0];
            reread.set(path, fileData ? { tabId, fileData } : null);
          }
        }
      }

      // 読んでいる間に次の読み直しが予約された・別のフォルダを開いた (求めは残し、新しい読み直しに任せる)
      if (generation !== this.screenshotGeneration || this.watchedRootFolderId !== rootFolderId) return;
      this.folderScreenshots = {
        rootHandle: current.rootHandle,
        screenshots: loaded.screenshots,
        startTimestamp: loaded.startTimestamp,
      };
      if (loaded.screenshotService) this.deps.onScreenshotServiceUpdate?.(loaded.screenshotService);
      for (const [path, entry] of reread) {
        const proof = entry === 'zip' ? this.zipProofToReplace(path) : entry;
        if (!proof) continue;
        this.deps.replaceFile(proof.tabId, proof.fileData, {
          screenshots: loaded.screenshots,
          startTimestamp: loaded.startTimestamp,
        });
      }
      if (this.screenshotResyncDemand === demand) this.screenshotResyncDemand = null;
      if (this.screenshotResyncFailing) {
        this.screenshotResyncFailing = false;
        this.deps.onStatusBarUpdate?.();
      }
    } catch (error) {
      // 何も確定しない。求めは残し (取り込み直しを省かないよう force にする)、次の成功した走査でやり直す
      console.error('Error reloading folder screenshots:', error);
      if (this.watchedRootFolderId !== rootFolderId) return;
      this.screenshotResyncDemand = { force: true };
      if (!this.screenshotResyncFailing) {
        this.screenshotResyncFailing = true;
        this.showReadFailure(error);
      }
    } finally {
      this.runningScreenshotResyncs--;
    }
  }

  /** フォルダのスクショへ落とした ZIP の proof の、いまのタブと ZIP から読んだ内容 (無くなっていれば null) */
  private zipProofToReplace(path: string): { tabId: string; fileData: ParsedFileData } | null {
    const fileData = this.zipScreenshotProofs.get(path);
    const tabId = this.deps.sidebar.getFileIdByPath(path);
    return fileData && tabId ? { tabId, fileData } : null;
  }

  /** 走査の一覧に無い proof (読み直しの間に足されたもの) のハンドルを引く。 */
  private async findFileEntry(root: FileSystemDirectoryHandle, path: string): Promise<FSAccessFileEntry | null> {
    const parts = path.split('/');
    const name = parts.pop() ?? path;
    let dir = root;
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const handle = await dir.getFileHandle(name);
      return { handle, path, name, lastModified: 0 };
    } catch {
      return null;
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
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    // ZIP の読み取りの失敗は投げる (呼び出し側がやり直しに回す。#773)。中身が壊れた ZIP (下の success: false) は
    // 読み直しても変わらないので、やり直さない
    const file = await fileEntry.handle.getFile();
    const bytes = await file.arrayBuffer();
    const result = await this.deps.fileProcessor.process(new File([bytes], file.name, { type: file.type }));
    // 読んでいる間に同じ ZIP の新しい読み込みが始まった (#787)。ここから先は await を挟まずに一覧を書き換える
    if (!isCurrent()) return;

    // 同じ ZIP から前に開いたもの (監視で ZIP が変わった) は外してから取り込み直す (#785)。新しい ZIP が壊れていても
    // 古い提出物のタブは残さない。外したフォルダ行を指す folderMap の項目も消す
    if (this.removeZipContents(fileEntry.path)) {
      const liveFolders = new Set(this.deps.sidebar.getAllFolders().map((folder) => folder.id));
      for (const [path, id] of folderMap) if (!liveFolders.has(id)) folderMap.delete(path);
    }

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
    const tabPaths: string[] = [];
    this.zipContents.set(fileEntry.path, { folderId: zipFolderId, tabPaths });

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

    // スクショは ZIP に同梱のものがあればそれ、無ければフォルダのスクショ (screenshots/ が無ければ 0 枚。
    // 開いたときに読めていなければ未検査。#773)。開いたときも監視中に足したときもこの規則を通る (#742)。
    // フォルダのスクショは ZIP を読み終えた後のここで引く (待つ前に引くと、その間に終わった読み直しの結果を取り逃す)
    const usesFolderScreenshots = !(result.screenshots && result.screenshots.length > 0);
    const container = usesFolderScreenshots
      ? this.folderContainer()
      : { screenshots: result.screenshots, startTimestamp: result.startTimestamp };
    if (!usesFolderScreenshots && result.screenshotService) {
      this.deps.onScreenshotServiceUpdate?.(result.screenshotService);
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
      tabPaths.push(fullRelativePath);

      if (fileData.type === 'proof') {
        // フォルダのスクショを渡した proof は、フォルダのスクショが変わったら取り込み直す (#703 / #742)
        if (usesFolderScreenshots) {
          this.screenshotProofPaths.add(fullRelativePath);
          this.zipScreenshotProofs.set(fullRelativePath, { ...fileData, relativePath: fullRelativePath });
        }
        this.deps.addFileToVerification(
          fileData.filename,
          fileData.rawData,
          fileFolderId,
          fullRelativePath,
          container.screenshots,
          container.startTimestamp
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
