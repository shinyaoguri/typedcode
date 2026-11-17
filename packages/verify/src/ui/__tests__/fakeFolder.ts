/**
 * UI テスト用の File System Access API のフォルダ (`FileSystemDirectoryHandle`) の最小 fake。
 *
 * 中身はパス → バイト列の表で持ち、ハンドルは呼ばれた時点の表を読む (外の編集ソフトでの書き換えを
 * `write` / `remove` で表す)。書くたびに `lastModified` が進むので、FolderSyncManager の監視が変更として拾う。
 * フォルダを開く処理・監視が使うメソッド (`values` / `getDirectoryHandle` / `getFileHandle` / `getFile`) だけを持つ。
 */

interface FakeEntry {
  bytes: Uint8Array;
  lastModified: number;
}

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError');
}

function mimeOf(name: string): string {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.json$/i.test(name)) return 'application/json';
  return 'text/plain';
}

export class FakeFolder {
  private entries = new Map<string, FakeEntry>();
  private clock = 1_000;

  /** `path` のファイルの `getFile()` の n 回目 (1 始まり) の前に待つ関数 (読み込みの終わる順を決める)。 */
  beforeGetFile?: (path: string, call: number) => Promise<void> | void;
  private getFileCalls = new Map<string, number>();

  constructor(
    readonly name: string,
    files: Record<string, string | Uint8Array> = {}
  ) {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
  }

  /** `path` の `getFile()` がこれまでに呼ばれた回数 (`beforeGetFile` で何回目を止める・失敗させるかを決める)。 */
  getFileCount(path: string): number {
    return this.getFileCalls.get(path) ?? 0;
  }

  /** ファイルを作る / 上書きする (`lastModified` が進む)。 */
  write(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.entries.set(path, { bytes, lastModified: ++this.clock });
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  handle(): FileSystemDirectoryHandle {
    return this.directory('', this.name);
  }

  private directory(prefix: string, name: string): FileSystemDirectoryHandle {
    const folder = this;
    return {
      kind: 'directory',
      name,
      async *values() {
        const seenDirs = new Set<string>();
        for (const path of [...folder.entries.keys()].sort()) {
          if (!path.startsWith(prefix)) continue;
          const [head, ...rest] = path.slice(prefix.length).split('/');
          if (!head) continue;
          if (rest.length === 0) {
            yield folder.file(path, head);
          } else if (!seenDirs.has(head)) {
            seenDirs.add(head);
            yield folder.directory(`${prefix}${head}/`, head);
          }
        }
      },
      async getDirectoryHandle(child: string) {
        const childPrefix = `${prefix}${child}/`;
        if (![...folder.entries.keys()].some((p) => p.startsWith(childPrefix))) throw notFound(child);
        return folder.directory(childPrefix, child);
      },
      async getFileHandle(child: string) {
        const path = `${prefix}${child}`;
        if (!folder.entries.has(path)) throw notFound(child);
        return folder.file(path, child);
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(path: string, name: string): FileSystemFileHandle {
    const folder = this;
    return {
      kind: 'file',
      name,
      async getFile() {
        const call = (folder.getFileCalls.get(path) ?? 0) + 1;
        folder.getFileCalls.set(path, call);
        await folder.beforeGetFile?.(path, call);
        const entry = folder.entries.get(path);
        if (!entry) throw notFound(name);
        return new File([entry.bytes.slice()], name, { type: mimeOf(name), lastModified: entry.lastModified });
      },
    } as unknown as FileSystemFileHandle;
  }
}
