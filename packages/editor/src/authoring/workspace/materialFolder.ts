/**
 * 教材フォルダの読み書き (#795 / ADR-0051 Decision 9・10、docs/system-spec.md §4.10)。
 *
 * `/author` が開いた教材フォルダ (File System Access API のディレクトリハンドル) を包み、ファイルの列挙・
 * 読み込み・書き込み・作成をする。画面 (段階 4) と定義ファイルの読み書き (#794) はこれの上に載る。
 *
 * - **パス**は開いたフォルダの根からの相対 POSIX パス (区切り `/`、先頭に `/` を付けない。例
 *   `過去問/探索.problem.yaml`)。空の区間・`.`・`..`・`\` を含むパスは受け付けない (フォルダの外に出さない)
 * - 列挙は `.` で始まる隠しファイル・フォルダを飛ばす (`.git` や同期ソフトの管理ファイルを教材に混ぜない)
 * - **外部での変更を上書きしない** (Decision 10): 読み込んだときの `lastModified` を覚え、保存の前に今の値と
 *   比べる。違えば書かずに `conflict` を返す。このオブジェクトが読んでいないファイルが既に在る場合も、黙って
 *   上書きせずに `conflict` を返す (新規作成は「無ければ作る」)。読み込んだ後に消えていた場合も `conflict`
 *   (消えたことも外部の変更なので、勝手に作り直さない)。競合を承知で書くときは `{ overwrite: true }` を渡す
 * - **書き込みの失敗は例外にせず結果で返す** (`failed`。権限の取り消し・`createWritable` / `write` の例外など)。
 *   書きかけのストリームは `abort()` で捨てるので、元のファイルは書き換わらない。呼び出し側は自分の持つ
 *   未保存の内容をそのまま残して、後で保存し直せる
 * - 保存に成功したら覚えている `lastModified` を書いた後の値に更新する (続けて保存しても自分自身と競合しない)
 *
 * 秘密 (署名鍵・監督コード) をここ経由で教材フォルダに書かないことは呼び出し側の約束 (Decision 10)。
 */

/** 競合の理由。`modified` = 読んだ後に変わった、`deleted` = 読んだ後に消えた、`exists` = 読んでいないファイルが在る */
export type FolderConflictReason = 'modified' | 'deleted' | 'exists';

/** テキストの書き込みの結果。例外にせず、この 3 通りで返す */
export type FolderWriteResult =
  | { readonly status: 'saved'; readonly path: string; readonly lastModified: number }
  | {
      readonly status: 'conflict';
      readonly path: string;
      readonly reason: FolderConflictReason;
      /** 読み込んだときの値 (読んでいなければ undefined) */
      readonly knownLastModified: number | undefined;
      /** 今の値 (消えていれば undefined) */
      readonly currentLastModified: number | undefined;
    }
  | { readonly status: 'failed'; readonly path: string; readonly cause: unknown };

/** フォルダの作成の結果 */
export type FolderCreateResult =
  | { readonly status: 'created'; readonly path: string }
  | { readonly status: 'failed'; readonly path: string; readonly cause: unknown };

export interface WriteTextOptions {
  /** 競合 (外部の変更・読んでいないファイル) を承知で上書きする */
  readonly overwrite?: boolean;
}

/** 教材フォルダの中のパスとして受け付けない形 */
export class InvalidFolderPathError extends Error {
  constructor(readonly path: string) {
    super(`Invalid material folder path: ${JSON.stringify(path)}`);
    this.name = 'InvalidFolderPathError';
  }
}

/**
 * 相対 POSIX パスを区間に分ける。空・先頭の `/`・空の区間 (`a//b`・末尾の `/`)・`.`・`..`・`\` は拒否する。
 */
export function splitFolderPath(path: string): string[] {
  if (path === '' || path.includes('\\')) throw new InvalidFolderPathError(path);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new InvalidFolderPathError(path);
  }
  return segments;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  // TypeMismatchError: 同じ名前のフォルダ / ファイルが在る (ファイルとしては無い)
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

interface FileStat {
  readonly handle: FileSystemFileHandle;
  readonly lastModified: number;
}

export class MaterialFolder {
  /** パス → このオブジェクトが最後に読んだ / 書いたときの `lastModified` */
  private readonly known = new Map<string, number>();

  constructor(readonly handle: FileSystemDirectoryHandle) {}

  /** フォルダ名 (ハンドルの `name`) */
  get name(): string {
    return this.handle.name;
  }

  /**
   * サブフォルダを含むファイルの一覧 (根からの相対パス、辞書順)。`.` で始まるファイル・フォルダは飛ばす。
   * 空のフォルダは含まない。
   */
  async listFiles(): Promise<string[]> {
    const paths: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        if (entry.name.startsWith('.')) continue;
        const path = `${prefix}${entry.name}`;
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, `${path}/`);
        } else {
          paths.push(path);
        }
      }
    };
    await walk(this.handle, '');
    return paths.sort();
  }

  /** テキストファイルを読む (UTF-8)。読んだときの `lastModified` を覚える。無ければ `NotFoundError` で reject */
  async readText(path: string): Promise<string> {
    const segments = splitFolderPath(path);
    const fileHandle = await this.fileHandle(segments);
    const file = await fileHandle.getFile();
    const text = await file.text();
    this.known.set(path, file.lastModified);
    return text;
  }

  /** ファイルが在るか (フォルダは false)。パスの形が不正なら `InvalidFolderPathError` で reject */
  async exists(path: string): Promise<boolean> {
    return (await this.stat(splitFolderPath(path))) !== null;
  }

  /**
   * テキストを書く。無ければ中間のフォルダごと作る。外部の変更・読んでいないファイルは `overwrite` が無ければ
   * 書かずに `conflict` を返す。失敗は `failed` で返し、例外にしない。
   */
  async writeText(path: string, text: string, options: WriteTextOptions = {}): Promise<FolderWriteResult> {
    return this.write(path, text, options.overwrite === true ? 'overwrite' : 'checked');
  }

  /** 新しいファイルを作る。同じパスにファイルが在れば (読んだことがあっても) 書かずに `conflict` (`exists`) */
  async createFile(path: string, text = ''): Promise<FolderWriteResult> {
    return this.write(path, text, 'create-only');
  }

  /** フォルダを作る (中間のフォルダも作る。既に在れば何もせず created)。失敗は `failed` で返す */
  async createFolder(path: string): Promise<FolderCreateResult> {
    try {
      await this.directory(splitFolderPath(path), true);
      return { status: 'created', path };
    } catch (cause) {
      return { status: 'failed', path, cause };
    }
  }

  private async write(
    path: string,
    text: string,
    mode: 'checked' | 'overwrite' | 'create-only'
  ): Promise<FolderWriteResult> {
    try {
      const segments = splitFolderPath(path);
      const current = await this.stat(segments);
      const known = this.known.get(path);
      const conflict = (reason: FolderConflictReason): FolderWriteResult => ({
        status: 'conflict',
        path,
        reason,
        knownLastModified: known,
        currentLastModified: current?.lastModified,
      });
      if (mode === 'create-only' && current) return conflict('exists');
      if (mode === 'checked') {
        if (current && known === undefined) return conflict('exists');
        if (current && known !== current.lastModified) return conflict('modified');
        if (!current && known !== undefined) return conflict('deleted');
      }

      let fileHandle = current?.handle;
      if (!fileHandle) {
        const dir = await this.directory(segments.slice(0, -1), true);
        fileHandle = await dir.getFileHandle(segments[segments.length - 1] as string, { create: true });
        // 自分で作った空のファイル。この後の書き込みが失敗しても、保存し直しが「読んでいないファイル」と
        // 競合しないよう覚えておく
        this.known.set(path, (await fileHandle.getFile()).lastModified);
      }

      const writable = await fileHandle.createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        // 書きかけを捨てる (createWritable は一時ファイルに書くので、元のファイルは close まで変わらない)
        await writable.abort().catch(() => undefined);
        throw error;
      }
      const lastModified = (await fileHandle.getFile()).lastModified;
      this.known.set(path, lastModified);
      return { status: 'saved', path, lastModified };
    } catch (cause) {
      return { status: 'failed', path, cause };
    }
  }

  /** ファイルのハンドルと今の `lastModified`。無ければ null (途中のフォルダが無い場合も) */
  private async stat(segments: readonly string[]): Promise<FileStat | null> {
    let handle: FileSystemFileHandle;
    try {
      handle = await this.fileHandle(segments);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const file = await handle.getFile();
    return { handle, lastModified: file.lastModified };
  }

  private async fileHandle(segments: readonly string[]): Promise<FileSystemFileHandle> {
    const dir = await this.directory(segments.slice(0, -1), false);
    return dir.getFileHandle(segments[segments.length - 1] as string);
  }

  private async directory(segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = this.handle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }
}
