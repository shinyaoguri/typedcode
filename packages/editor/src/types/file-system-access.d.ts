/**
 * File System Access API のうち、TypeScript の lib.dom に無い分だけの型宣言 (#795)。
 *
 * ハンドル本体 (`FileSystemDirectoryHandle` / `FileSystemFileHandle` / `createWritable` / `values()`) は
 * lib.dom にある。権限の確認・要求と、フォルダのピッカーは Chrome / Edge だけが持つので lib.dom に無く、
 * ここで足す。OPFS (`navigator.storage.getDirectory()`) のハンドルや Chromium 以外では無いことがあるので、
 * どれも省略可能にしておき、使う側で有無を確かめる。
 *
 * verify にも同じ趣旨の宣言 (`packages/verify/src/types/file-system-access.d.ts`) があるが、パッケージを
 * またいで共有しない (verify は読み取り専用の別実装。ADR-0051 / #795 のスコープ外)。
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | FileSystemHandle;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
