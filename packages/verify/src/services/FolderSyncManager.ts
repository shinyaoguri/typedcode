/**
 * FolderSyncManager - フォルダ変更監視サービス
 *
 * ポーリング方式で外部でのファイル変更を検知し、UIを自動更新します。
 * File System Observer API が広くサポートされるまでの代替実装。
 */

import type { FileSnapshot, SyncManagerCallbacks } from '../types.js';

/**
 * フォルダ同期マネージャー
 */
export class FolderSyncManager {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private fileSnapshots: Map<string, FileSnapshot> = new Map();
  private folderPaths: Set<string> = new Set();
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
   */
  async startWatching(
    handle: FileSystemDirectoryHandle,
    intervalMs?: number
  ): Promise<void> {
    this.rootHandle = handle;
    this.syncIntervalMs = intervalMs ?? this.syncIntervalMs;

    // 初期スナップショットを取得
    await this.takeSnapshot();

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
  }

  /**
   * 現在のディレクトリ状態のスナップショットを取得
   */
  private async takeSnapshot(): Promise<void> {
    if (!this.rootHandle) return;

    this.fileSnapshots.clear();
    this.folderPaths.clear();

    await this.traverseForSnapshot(this.rootHandle, '');
  }

  /**
   * スナップショット用にディレクトリを走査
   */
  private async traverseForSnapshot(
    handle: FileSystemDirectoryHandle,
    currentPath: string
  ): Promise<void> {
    try {
      for await (const entry of handle.values()) {
        const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

        if (entry.kind === 'directory') {
          this.folderPaths.add(entryPath);
          await this.traverseForSnapshot(
            entry as FileSystemDirectoryHandle,
            entryPath
          );
        } else {
          const fileHandle = entry as FileSystemFileHandle;
          try {
            const file = await fileHandle.getFile();
            this.fileSnapshots.set(entryPath, {
              path: entryPath,
              lastModified: file.lastModified,
              handle: fileHandle,
            });
          } catch {
            // ファイル読み取りエラーはスキップ
          }
        }
      }
    } catch {
      // ディレクトリアクセスエラーはスキップ
    }
  }

  /**
   * 前回のスナップショットからの変更をチェック
   */
  private async checkForChanges(): Promise<void> {
    if (!this.rootHandle || !this.isRunning) return;

    try {
      const currentFiles = new Map<string, FileSnapshot>();
      const currentFolders = new Set<string>();

      await this.traverseForComparison(
        this.rootHandle,
        '',
        currentFiles,
        currentFolders
      );

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
      this.fileSnapshots = currentFiles;
      this.folderPaths = currentFolders;

      this.callbacks.onSyncComplete?.();
    } catch (error) {
      this.callbacks.onSyncError?.(error as Error);
    }
  }

  /**
   * 比較用にディレクトリを走査
   */
  private async traverseForComparison(
    handle: FileSystemDirectoryHandle,
    currentPath: string,
    files: Map<string, FileSnapshot>,
    folders: Set<string>
  ): Promise<void> {
    try {
      for await (const entry of handle.values()) {
        const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

        if (entry.kind === 'directory') {
          folders.add(entryPath);
          await this.traverseForComparison(
            entry as FileSystemDirectoryHandle,
            entryPath,
            files,
            folders
          );
        } else {
          const fileHandle = entry as FileSystemFileHandle;
          try {
            const file = await fileHandle.getFile();
            files.set(entryPath, {
              path: entryPath,
              lastModified: file.lastModified,
              handle: fileHandle,
            });
          } catch {
            // ファイル読み取りエラーはスキップ
          }
        }
      }
    } catch {
      // ディレクトリアクセスエラーはスキップ
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
