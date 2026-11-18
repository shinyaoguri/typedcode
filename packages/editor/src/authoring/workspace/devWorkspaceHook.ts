/**
 * `/author` の E2E 専用フック `window.__tcTestAuthorWorkspace` (dev ビルドのみ。#795)。
 *
 * ネイティブのフォルダのピッカーは Playwright で操作できないので、テストが OPFS
 * (`navigator.storage.getDirectory()`) のディレクトリハンドルを教材フォルダとして渡し、保存 → 読み直し →
 * 前回のフォルダで再開、の経路を本物の IndexedDB と File System Access API で通す。
 *
 * `authorMain.ts` が `import.meta.env.DEV` のガードの中で dynamic import するので、本番ビルドには入らない
 * (production-build.spec が `/author` で undefined であることを見張る)。返す値はどれも `page.evaluate` で
 * 受け取れる形 (文字列・配列・プレーンなオブジェクト) にする。
 */

import { openMaterialFolderHandle, resumeMaterialFolder } from './folderAccess.js';
import { FolderHandleStore } from './folderHandleStore.js';
import type { MaterialFolder } from './materialFolder.js';

export interface TestAuthorWorkspace {
  /** ハンドルを教材フォルダとして開き、再訪用に覚える。フォルダ名を返す */
  open(handle: FileSystemDirectoryHandle): Promise<string>;
  /** 前回のフォルダで再開する。`opened` なら以後の list / read / write はそのフォルダに対して行う */
  resume(): Promise<{ status: string; name?: string; reason?: string }>;
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  /** 書き込みの結果 (`saved` / `conflict` / `failed`) と、競合の理由 */
  write(path: string, text: string, overwrite?: boolean): Promise<{ status: string; reason?: string }>;
}

declare global {
  interface Window {
    /** E2E 専用 (dev ビルドのみ)。本番ビルドでは undefined (production-build.spec が見張る) */
    __tcTestAuthorWorkspace?: TestAuthorWorkspace;
  }
}

export function installAuthorWorkspaceHook(): void {
  const store = new FolderHandleStore();
  let current: MaterialFolder | null = null;
  const folder = (): MaterialFolder => {
    if (!current) throw new Error('No material folder is open');
    return current;
  };

  window.__tcTestAuthorWorkspace = {
    async open(handle) {
      const result = await openMaterialFolderHandle(handle, store);
      if (result.status !== 'opened') throw new Error(`open failed: ${result.status}`);
      current = result.folder;
      return result.folder.name;
    },
    async resume() {
      const result = await resumeMaterialFolder(store);
      switch (result.status) {
        case 'opened':
          current = result.folder;
          return { status: 'opened', name: result.folder.name };
        case 'needs-permission':
          return { status: 'needs-permission', name: result.name };
        case 'unavailable':
          return { status: 'unavailable', name: result.name, reason: result.reason };
        default:
          return { status: result.status };
      }
    },
    list: () => folder().listFiles(),
    read: (path) => folder().readText(path),
    async write(path, text, overwrite = false) {
      const result = await folder().writeText(path, text, { overwrite });
      return result.status === 'conflict'
        ? { status: result.status, reason: result.reason }
        : { status: result.status };
    },
  };
}
