/**
 * `/author` の E2E 専用フック `window.__tcTestAuthorWorkspace` (dev ビルドのみ。#795 / #796)。
 *
 * ネイティブのフォルダのピッカーは Playwright で操作できないので、テストが OPFS
 * (`navigator.storage.getDirectory()`) のディレクトリハンドルを教材フォルダとして渡す。
 *
 * - `openInPage(handle)`: ピッカーの代わりに、実際の作問画面がそのフォルダを開く (覚えるので、読み直すと前回の
 *   フォルダとして再開する)。画面の操作と保存はここからではなく画面の部品で行う
 * - `document(path)`: 画面が開いている文書の状態 (保存済みのテキスト・今のテキスト・未保存か)。Monaco の表示は
 *   空白や折り返しで読みにくいので、テキストの照合はこちらで行う
 * - `setNextPickedDirectory(handle)`: 画面が次に開くフォルダのピッカーの結果を、渡したハンドルに差し替える (1 回だけ。
 *   問題のコピー先の選択など。#800)
 * - `open` / `resume` / `list` / `read` / `write`: 画面を通さずにフォルダの読み書きと再開を試す (#795)
 * - `setFakeVerification(entries)` / `fakeVerificationCalls()`: 検証の実行の入口を偽物 (`verification/fakeRunner.ts`)
 *   に差し替え、呼ばれた順を読む (#799)
 *
 * `authorMain.ts` が `import.meta.env.DEV` のガードの中で dynamic import するので、本番ビルドには入らない
 * (production-build.spec が `/author` で undefined であることを見張る)。返す値はどれも `page.evaluate` で
 * 受け取れる形 (文字列・配列・プレーンなオブジェクト) にする。
 */

import { openMaterialFolderHandle, resumeMaterialFolder } from './folderAccess.js';
import { FolderHandleStore } from './folderHandleStore.js';
import type { MaterialFolder } from './materialFolder.js';
import type { NonInteractiveRunner } from '../../executors/nonInteractive/runNonInteractive.js';
import {
  createFakeVerificationRunner,
  type FakeVerificationEntry,
  type FakeVerificationRunner,
} from '../verification/fakeRunner.js';

/** フックが画面に求める入口 (`AuthorPage` が満たす) */
export interface AuthorPageTestSurface {
  openFolderHandle(handle: FileSystemDirectoryHandle): Promise<void>;
  documentState(path: string): { path: string; savedText: string; text: string; dirty: boolean } | null;
  setVerificationRunner(runner: NonInteractiveRunner | null): void;
  setNextPickedDirectory(handle: FileSystemDirectoryHandle | null): void;
}

export interface TestAuthorWorkspace {
  /** 作問画面でハンドルを教材フォルダとして開く (作業画面になるまで待つ)。フォルダ名を返す */
  openInPage(handle: FileSystemDirectoryHandle): Promise<string>;
  /** 画面が開いている文書の状態。開いていなければ null */
  document(path: string): { path: string; savedText: string; text: string; dirty: boolean } | null;
  /**
   * 画面が次にフォルダのピッカーを開いたとき、ピッカーを出さずにこのハンドルを選んだことにする (1 回使ったら戻る。
   * null で取り消す。#800)。コピー先の選択などに使う
   */
  setNextPickedDirectory(handle: FileSystemDirectoryHandle | null): void;
  /** ハンドルを教材フォルダとして開き、再訪用に覚える (画面は変えない)。フォルダ名を返す */
  open(handle: FileSystemDirectoryHandle): Promise<string>;
  /** 前回のフォルダで再開する。`opened` なら以後の list / read / write はそのフォルダに対して行う */
  resume(): Promise<{ status: string; name?: string; reason?: string }>;
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  /** 書き込みの結果 (`saved` / `conflict` / `failed`) と、競合の理由 */
  write(path: string, text: string, overwrite?: boolean): Promise<{ status: string; reason?: string }>;
  /**
   * 検証の実行の入口を、対応表どおりに結果を返す偽物に差し替える (#799)。null で実物 (`runNonInteractive`) に戻す。
   * PR ごとの E2E が実物のコンパイラを使わずに結果表・差分・中止を確かめるため
   */
  setFakeVerification(entries: FakeVerificationEntry[] | null): void;
  /** 偽物の入口が呼ばれた順の (ファイル名, stdin)。偽物でなければ空 */
  fakeVerificationCalls(): { filename: string; stdin: string }[];
}

declare global {
  interface Window {
    /** E2E 専用 (dev ビルドのみ)。本番ビルドでは undefined (production-build.spec が見張る) */
    __tcTestAuthorWorkspace?: TestAuthorWorkspace;
  }
}

export function installAuthorWorkspaceHook(page: AuthorPageTestSurface | null): void {
  const store = new FolderHandleStore();
  let current: MaterialFolder | null = null;
  let fake: FakeVerificationRunner | null = null;
  const folder = (): MaterialFolder => {
    if (!current) throw new Error('No material folder is open');
    return current;
  };
  const surface = (): AuthorPageTestSurface => {
    if (!page) throw new Error('The author page is not mounted');
    return page;
  };

  window.__tcTestAuthorWorkspace = {
    async openInPage(handle) {
      await surface().openFolderHandle(handle);
      return handle.name;
    },
    document: (path) => surface().documentState(path),
    setNextPickedDirectory: (handle) => surface().setNextPickedDirectory(handle),
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
    setFakeVerification(entries) {
      fake = entries ? createFakeVerificationRunner(entries) : null;
      surface().setVerificationRunner(fake ? fake.run : null);
    },
    fakeVerificationCalls: () => fake?.calls() ?? [],
  };
}
