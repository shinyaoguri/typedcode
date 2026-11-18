/**
 * テスト用の、メモリ上の File System Access API のフォルダ (#795)。
 *
 * `MaterialFolder` / `resumeMaterialFolder` が使うハンドルの操作 (`values` / `getDirectoryHandle` /
 * `getFileHandle(name, { create })` / `getFile` / `createWritable` (`write` / `close` / `abort`) /
 * `queryPermission` / `requestPermission`) を持つ。後の段階 (作問画面など) のユニットテストからも使う。
 *
 * - 中身はパス (根からの相対 POSIX パス) → `{ text, lastModified }` の表と、フォルダの集合で持つ。ハンドルは
 *   呼ばれた時点の表を読む
 * - `lastModified` は決定的な時計で、書くたびに 1 進む (`touch` / `writeExternally` は外部での変更の代役)
 * - `createWritable` は一時ファイルに書き、`close` で確定・`abort` で捨てる (実物と同じく close まで元は変わらない)
 * - 権限は `permission` で持ち、`granted` でない間の読み書きは `NotAllowedError` で拒否する。読み書きを試みた
 *   回数を `accessCount` で数える (権限を得る前に触っていないことを確かめる)
 * - `failWrites` で書き込みの例外を注入する。`removeFolder()` は根のフォルダが消えた状態を作る
 */

interface FakeFile {
  text: string;
  lastModified: number;
}

export type WriteStage = 'createWritable' | 'write' | 'close';

/** fake のハンドル (`isFakeHandle` で見分ける。IndexedDB の structured clone の代役が素通しにするため) */
const fakeHandles = new WeakSet<object>();

export function isFakeHandle(value: unknown): boolean {
  return typeof value === 'object' && value !== null && fakeHandles.has(value);
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

export class FakeFileSystem {
  private readonly files = new Map<string, FakeFile>();
  private readonly folders = new Set<string>();
  private clock = 1_000;
  private removed = false;

  /** 今の権限 (`queryPermission` が返す値) */
  permission: PermissionState = 'granted';
  /** `requestPermission` が返し、以後の `permission` になる値 */
  requestResult: PermissionState = 'granted';
  queryPermissionCalls = 0;
  requestPermissionCalls = 0;
  /** 読み書き (列挙・ハンドルの取得・読み込み・書き込み) を試みた回数 */
  accessCount = 0;
  /** 書き込みの各段で投げる例外を返す (undefined なら投げない) */
  failWrites?: (path: string, stage: WriteStage) => Error | undefined;

  constructor(
    readonly rootName: string,
    files: Record<string, string> = {}
  ) {
    for (const [path, text] of Object.entries(files)) this.writeExternally(path, text);
  }

  /** 外部 (別のエディタ・同期ソフト) での書き込み。`lastModified` が進む */
  writeExternally(path: string, text: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
    this.files.set(path, { text, lastModified: ++this.clock });
  }

  /** 内容を変えずに `lastModified` だけ進める (外部での変更の代役) */
  touch(path: string): void {
    const file = this.files.get(path);
    if (!file) throw new Error(`no such fake file: ${path}`);
    file.lastModified = ++this.clock;
  }

  /** 外部での削除 */
  deleteExternally(path: string): void {
    this.files.delete(path);
  }

  /** 根のフォルダが消えた状態にする (以後の操作は NotFoundError) */
  removeFolder(): void {
    this.removed = true;
  }

  readFile(path: string): string | undefined {
    return this.files.get(path)?.text;
  }

  lastModifiedOf(path: string): number | undefined {
    return this.files.get(path)?.lastModified;
  }

  /** すべてのファイルのパス → 内容 (パス順)。書き込みが起きていないことの照合に使う */
  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => [p, f.text])
    );
  }

  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  /** 根のフォルダのハンドル */
  root(): FileSystemDirectoryHandle {
    return this.directory('', this.rootName);
  }

  private access(): void {
    this.accessCount++;
    if (this.removed) throw domError('NotFoundError', `${this.rootName} was removed`);
    if (this.permission !== 'granted') throw domError('NotAllowedError', 'permission is not granted');
  }

  private mark<T extends object>(handle: T): T {
    fakeHandles.add(handle);
    return handle;
  }

  private directory(path: string, name: string): FileSystemDirectoryHandle {
    const fs = this;
    const prefix = path === '' ? '' : `${path}/`;
    const childPath = (child: string) => `${prefix}${child}`;
    const handle = {
      kind: 'directory' as const,
      name,
      async *values() {
        fs.access();
        const seen = new Set<string>();
        const children: Array<{ kind: 'file' | 'directory'; name: string }> = [];
        for (const p of [...fs.folders, ...fs.files.keys()]) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          if (rest === '' || rest.includes('/')) continue;
          if (seen.has(rest)) continue;
          seen.add(rest);
          children.push({ kind: fs.files.has(p) ? 'file' : 'directory', name: rest });
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          yield child.kind === 'file'
            ? fs.file(childPath(child.name), child.name)
            : fs.directory(childPath(child.name), child.name);
        }
      },
      async getDirectoryHandle(child: string, options: { create?: boolean } = {}) {
        fs.access();
        const p = childPath(child);
        if (fs.files.has(p)) throw domError('TypeMismatchError', `${p} is a file`);
        if (!fs.folders.has(p)) {
          if (!options.create) throw domError('NotFoundError', `${p} not found`);
          fs.folders.add(p);
        }
        return fs.directory(p, child);
      },
      async getFileHandle(child: string, options: { create?: boolean } = {}) {
        fs.access();
        const p = childPath(child);
        if (fs.folders.has(p)) throw domError('TypeMismatchError', `${p} is a folder`);
        if (!fs.files.has(p)) {
          if (!options.create) throw domError('NotFoundError', `${p} not found`);
          fs.files.set(p, { text: '', lastModified: ++fs.clock });
        }
        return fs.file(p, child);
      },
      async queryPermission() {
        fs.queryPermissionCalls++;
        return fs.permission;
      },
      async requestPermission() {
        fs.requestPermissionCalls++;
        fs.permission = fs.requestResult;
        return fs.permission;
      },
      async isSameEntry(other: unknown) {
        return other === handle;
      },
    };
    return this.mark(handle) as unknown as FileSystemDirectoryHandle;
  }

  private file(path: string, name: string): FileSystemFileHandle {
    const fs = this;
    const handle = {
      kind: 'file' as const,
      name,
      async getFile() {
        fs.access();
        const entry = fs.files.get(path);
        if (!entry) throw domError('NotFoundError', `${path} not found`);
        return new File([entry.text], name, { lastModified: entry.lastModified });
      },
      async createWritable() {
        fs.access();
        const fail = (stage: WriteStage) => {
          const error = fs.failWrites?.(path, stage);
          if (error) throw error;
        };
        fail('createWritable');
        let buffer = '';
        let open = true;
        return {
          async write(data: string) {
            fs.access();
            fail('write');
            buffer += data;
          },
          async close() {
            fs.access();
            fail('close');
            if (!open) throw new TypeError('stream is closed');
            open = false;
            fs.files.set(path, { text: buffer, lastModified: ++fs.clock });
          },
          async abort() {
            open = false;
            buffer = '';
          },
        };
      },
      async isSameEntry(other: unknown) {
        return other === handle;
      },
    };
    return this.mark(handle) as unknown as FileSystemFileHandle;
  }
}
