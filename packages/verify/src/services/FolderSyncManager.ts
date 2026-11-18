/**
 * FolderSyncManager - フォルダ変更監視サービス
 *
 * ポーリング方式で外部でのファイル変更を検知し、UIを自動更新します。
 * File System Observer API が広くサポートされるまでの代替実装。
 */

import type { FileSnapshot, FSAccessFileEntry, FSAccessFolderEntry, SyncManagerCallbacks } from '../types.js';

/** 監視の基準にする、フォルダを開いたときに読み込んだ一覧 (`FileSystemAccessService.readDirectoryRecursive` の結果と同じ形) */
export interface InitialListing {
  files: readonly FSAccessFileEntry[];
  folders: readonly FSAccessFolderEntry[];
}

/**
 * フォルダ同期マネージャー
 */
export class FolderSyncManager {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private fileSnapshots: Map<string, FileSnapshot> = new Map();
  private folderPaths: Set<string> = new Set();
  /** 比較の基準を持っているか。不完全な走査は基準にしない (#734) ので、初回が読めなかった間は false */
  private hasBaseline = false;
  private syncInterval: number | null = null;
  private callbacks: SyncManagerCallbacks;
  private isRunning = false;

  // デフォルト同期間隔: 3秒
  private syncIntervalMs = 3000;

  constructor(callbacks: SyncManagerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: SyncManagerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * ディレクトリの監視を開始
   *
   * `initial` (フォルダを開いたときに読み込んだ一覧) を渡すと、それを比較の基準にして初回の走査をしない (#734)。
   * 基準が「実際に読み込んだもの」になるので、開くときに読めずに飛ばしたファイルは次の走査で追加として通知され、
   * 読み込み済みのファイルが追加として重なることはない。開いてから監視を始めるまでの間の変更も次の走査で拾う。
   *
   * 渡さないときは初回の走査を基準にするが、読めなかった回は基準にしない (読めなかったエントリを基準から黙って抜くと、
   * 次に読めた回に「追加」と通知してしまう)。基準を持たない間の走査は、最初に完全に読めた回を通知なしで基準にする。
   */
  async startWatching(handle: FileSystemDirectoryHandle, intervalMs?: number, initial?: InitialListing): Promise<void> {
    this.rootHandle = handle;
    this.syncIntervalMs = intervalMs ?? this.syncIntervalMs;

    if (initial) {
      this.setBaseline(
        new Map(
          initial.files.map((f) => [f.path, { path: f.path, lastModified: f.lastModified, handle: f.handle }] as const)
        ),
        new Set(initial.folders.map((f) => f.path))
      );
    } else {
      await this.takeSnapshot();
    }

    // ポーリング開始
    this.isRunning = true;
    this.syncInterval = window.setInterval(() => {
      this.checkForChanges();
    }, this.syncIntervalMs);
  }

  /**
   * 監視を停止
   */
  stopWatching(): void {
    this.isRunning = false;
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.rootHandle = null;
    this.fileSnapshots.clear();
    this.folderPaths.clear();
    this.hasBaseline = false;
  }

  /**
   * 現在のディレクトリ状態を走査して基準にする。読めなかったら基準を持たないままにする (#734)
   */
  private async takeSnapshot(): Promise<void> {
    if (!this.rootHandle) return;

    this.fileSnapshots.clear();
    this.folderPaths.clear();
    this.hasBaseline = false;

    const files = new Map<string, FileSnapshot>();
    const folders = new Set<string>();
    try {
      await this.traverseForComparison(this.rootHandle, '', files, folders);
    } catch {
      return;
    }
    this.setBaseline(files, folders);
  }

  private setBaseline(files: Map<string, FileSnapshot>, folders: Set<string>): void {
    this.fileSnapshots = files;
    this.folderPaths = folders;
    this.hasBaseline = true;
  }

  /**
   * 前回のスナップショットからの変更をチェック
   *
   * 走査が 1 か所でも読めなかった回は不完全な回として扱い、追加・変更・削除を一切確定しない (#699)。
   * 差分の通知とスナップショットの更新は走査が最後まで読めた後にだけ行い、失敗した回は前回の
   * スナップショットを保ったまま onSyncError で知らせる。その間の変更は、次に完全に読めた回の差分で拾う。
   * 基準の作り方 (初回) も同じ規則に従う (#734。startWatching)。
   */
  private async checkForChanges(): Promise<void> {
    if (!this.rootHandle || !this.isRunning) return;

    try {
      const currentFiles = new Map<string, FileSnapshot>();
      const currentFolders = new Set<string>();

      await this.traverseForComparison(this.rootHandle, '', currentFiles, currentFolders);

      // 基準を持たない (初回の走査が読めなかった) 間は、最初に完全に読めた回を通知なしで基準にする (#734)
      if (!this.hasBaseline) {
        this.setBaseline(currentFiles, currentFolders);
        this.callbacks.onSyncComplete?.();
        return;
      }

      // 削除されたファイルを検出
      for (const [path] of this.fileSnapshots) {
        if (!currentFiles.has(path)) {
          this.callbacks.onFileDeleted?.(path);
        }
      }

      // 削除されたフォルダを検出
      for (const path of this.folderPaths) {
        if (!currentFolders.has(path)) {
          this.callbacks.onFolderDeleted?.(path);
        }
      }

      // 追加・変更されたファイルを検出
      for (const [path, snapshot] of currentFiles) {
        const oldSnapshot = this.fileSnapshots.get(path);

        if (!oldSnapshot) {
          // 新規ファイル
          this.callbacks.onFileAdded?.({
            handle: snapshot.handle,
            path: snapshot.path,
            name: path.split('/').pop() ?? path,
            lastModified: snapshot.lastModified,
          });
        } else if (oldSnapshot.lastModified !== snapshot.lastModified) {
          // 変更されたファイル
          this.callbacks.onFileModified?.({
            handle: snapshot.handle,
            path: snapshot.path,
            name: path.split('/').pop() ?? path,
            lastModified: snapshot.lastModified,
          });
        }
      }

      // 追加されたフォルダを検出
      for (const path of currentFolders) {
        if (!this.folderPaths.has(path)) {
          const name = path.split('/').pop() ?? path;
          this.callbacks.onFolderAdded?.(path, name);
        }
      }

      // スナップショットを更新
      this.setBaseline(currentFiles, currentFolders);

      this.callbacks.onSyncComplete?.();
    } catch (error) {
      this.callbacks.onSyncError?.(error as Error);
    }
  }

  /**
   * 比較用にディレクトリを走査
   *
   * 読み取りの失敗 (ディレクトリの values()・個別の getFile()) は握り潰さずに投げる (#699)。
   * 読めなかったエントリを結果から黙って抜くと、checkForChanges が「消えた」と見て削除を通知し、
   * 読み込み済みのタブ・検証結果を一覧から外してしまう。失敗した回は checkForChanges が丸ごと捨てる。
   * 初回の基準作り (takeSnapshot) も同じ走査を使い、読めなかった回を基準にしない (#734)。
   */
  private async traverseForComparison(
    handle: FileSystemDirectoryHandle,
    currentPath: string,
    files: Map<string, FileSnapshot>,
    folders: Set<string>
  ): Promise<void> {
    for await (const entry of handle.values()) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

      if (entry.kind === 'directory') {
        folders.add(entryPath);
        await this.traverseForComparison(entry as FileSystemDirectoryHandle, entryPath, files, folders);
      } else {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        files.set(entryPath, {
          path: entryPath,
          lastModified: file.lastModified,
          handle: fileHandle,
        });
      }
    }
  }

  /**
   * 即座に同期チェックを実行
   */
  async forceSync(): Promise<void> {
    await this.checkForChanges();
  }

  /**
   * 現在の同期状態を取得
   */
  getState(): { isWatching: boolean; fileCount: number; folderCount: number } {
    return {
      isWatching: this.isRunning,
      fileCount: this.fileSnapshots.size,
      folderCount: this.folderPaths.size,
    };
  }

  /**
   * 監視中かどうかを確認
   */
  isWatching(): boolean {
    return this.isRunning;
  }

  /**
   * ルートハンドルを取得
   */
  getRootHandle(): FileSystemDirectoryHandle | null {
    return this.rootHandle;
  }
}
