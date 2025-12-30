/**
 * FileSystemAccessService - File System Access API ラッパー
 *
 * フォルダ選択、再帰的読み取り、権限管理を提供します。
 * Chrome/Edge でのみ利用可能。
 */

import type {
  FSAccessFileEntry,
  FSAccessFolderEntry,
  ReadDirectoryResult,
  FSAccessCallbacks,
} from '../types.js';

/**
 * File System Access API サービス
 */
export class FileSystemAccessService {
  private callbacks: FSAccessCallbacks;

  constructor(callbacks: FSAccessCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * File System Access API がサポートされているか確認
   */
  static isSupported(): boolean {
    return 'showDirectoryPicker' in window && window.isSecureContext;
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: FSAccessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * フォルダ選択ダイアログを表示
   */
  async showDirectoryPicker(): Promise<FileSystemDirectoryHandle | null> {
    if (!FileSystemAccessService.isSupported()) {
      this.callbacks.onError?.(new Error('File System Access API is not supported'));
      return null;
    }

    try {
      this.callbacks.onPermissionRequest?.();
      const handle = await window.showDirectoryPicker({
        mode: 'read',
      });
      this.callbacks.onPermissionGranted?.();
      return handle;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // ユーザーがキャンセル - エラーではない
        return null;
      }
      this.callbacks.onPermissionDenied?.(error as Error);
      return null;
    }
  }

  /**
   * ディレクトリを再帰的に読み取り
   */
  async readDirectoryRecursive(
    handle: FileSystemDirectoryHandle,
    basePath: string = ''
  ): Promise<ReadDirectoryResult> {
    const files: FSAccessFileEntry[] = [];
    const folders: FSAccessFolderEntry[] = [];

    try {
      await this.traverseDirectory(handle, basePath, files, folders);

      return {
        success: true,
        rootName: handle.name,
        files,
        folders,
      };
    } catch (error) {
      return {
        success: false,
        rootName: handle.name,
        files: [],
        folders: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * ディレクトリツリーを走査
   */
  private async traverseDirectory(
    handle: FileSystemDirectoryHandle,
    currentPath: string,
    files: FSAccessFileEntry[],
    folders: FSAccessFolderEntry[]
  ): Promise<void> {
    for await (const entry of handle.values()) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

      if (entry.kind === 'directory') {
        const dirHandle = entry as FileSystemDirectoryHandle;
        folders.push({
          handle: dirHandle,
          path: entryPath,
          name: entry.name,
        });

        await this.traverseDirectory(dirHandle, entryPath, files, folders);
      } else {
        const fileHandle = entry as FileSystemFileHandle;
        try {
          const file = await fileHandle.getFile();
          files.push({
            handle: fileHandle,
            path: entryPath,
            name: entry.name,
            lastModified: file.lastModified,
          });
        } catch {
          // ファイル読み取りエラーはスキップ
        }
      }
    }
  }

  /**
   * ファイル内容を読み取り
   */
  async readFile(handle: FileSystemFileHandle): Promise<string> {
    const file = await handle.getFile();
    return file.text();
  }

  /**
   * ファイルオブジェクトを取得
   */
  async getFile(handle: FileSystemFileHandle): Promise<File> {
    return handle.getFile();
  }

  /**
   * 権限を確認
   */
  async verifyPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const options = { mode: 'read' as const };

    if ((await handle.queryPermission(options)) === 'granted') {
      return true;
    }

    if ((await handle.requestPermission(options)) === 'granted') {
      return true;
    }

    return false;
  }
}
