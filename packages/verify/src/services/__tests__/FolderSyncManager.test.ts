// @vitest-environment happy-dom
/**
 * フォルダ監視の読み取り失敗は削除ではない (#699)。
 *
 * 走査のどこか (ディレクトリの values()・個別の getFile()) が読めなかった回は不完全な回として扱い、
 * 追加・変更・削除を確定しない。前回のスナップショットを保ち、onSyncError で失敗を知らせる。
 * 次に完全に走査できた回で、その間の変更 (本当の削除を含む) を通常どおり反映する。
 *
 * 実物の FolderSyncManager に、木構造を書き換えられる fake の FSA ハンドルを渡す。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncManagerCallbacks } from '../../types.js';
import { FolderSyncManager } from '../FolderSyncManager.js';

interface FakeFile {
  kind: 'file';
  lastModified: number;
  /** true の間 getFile() が NotAllowedError を投げる */
  unreadable?: boolean;
}
interface FakeDir {
  kind: 'directory';
  children: Record<string, FakeNode>;
  /** true の間 values() が NotAllowedError を投げる */
  unreadable?: boolean;
}
type FakeNode = FakeFile | FakeDir;

const denied = () => new DOMException('permission temporarily denied', 'NotAllowedError');

function fileHandle(name: string, node: FakeFile): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => {
      if (node.unreadable) throw denied();
      return { lastModified: node.lastModified } as File;
    },
  } as unknown as FileSystemFileHandle;
}

function dirHandle(name: string, node: FakeDir): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      if (node.unreadable) throw denied();
      for (const [childName, child] of Object.entries(node.children)) {
        yield child.kind === 'directory' ? dirHandle(childName, child) : fileHandle(childName, child);
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

const file = (lastModified = 1): FakeFile => ({ kind: 'file', lastModified });
const dir = (children: Record<string, FakeNode>): FakeDir => ({ kind: 'directory', children });

function callbacks() {
  return {
    onFileAdded: vi.fn(),
    onFileModified: vi.fn(),
    onFileDeleted: vi.fn(),
    onFolderAdded: vi.fn(),
    onFolderDeleted: vi.fn(),
    onSyncComplete: vi.fn(),
    onSyncError: vi.fn(),
  } satisfies SyncManagerCallbacks;
}

let manager: FolderSyncManager | null = null;

/** root を監視し始める (ポーリングは止めておき、forceSync で 1 回ずつ回す)。 */
async function watch(root: FakeDir) {
  const cb = callbacks();
  manager = new FolderSyncManager(cb);
  await manager.startWatching(dirHandle('root', root), 60 * 60 * 1000);
  return { cb, sync: () => manager!.forceSync(), state: () => manager!.getState() };
}

afterEach(() => {
  manager?.stopWatching();
  manager = null;
});

/** 差分の通知 (追加・変更・削除) が 1 つも出ていない */
function expectNoChangeReported(cb: ReturnType<typeof callbacks>) {
  expect(cb.onFileAdded).not.toHaveBeenCalled();
  expect(cb.onFileModified).not.toHaveBeenCalled();
  expect(cb.onFileDeleted).not.toHaveBeenCalled();
  expect(cb.onFolderAdded).not.toHaveBeenCalled();
  expect(cb.onFolderDeleted).not.toHaveBeenCalled();
}

describe('FolderSyncManager read failures (#699)', () => {
  it('reports an unreadable root as a sync error, not as deleted files, and keeps the last snapshot', async () => {
    const root = dir({ 'main_proof.json': file(), sub: dir({ 'a.c': file() }) });
    const { cb, sync, state } = await watch(root);

    root.unreadable = true;
    await sync();

    expectNoChangeReported(cb);
    expect(cb.onSyncError).toHaveBeenCalledTimes(1);
    expect(cb.onSyncComplete).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ fileCount: 2, folderCount: 1 });
  });

  it('does not report a file whose getFile() fails as deleted', async () => {
    const proof = file();
    const { cb, sync, state } = await watch(dir({ 'main_proof.json': proof, 'main.c': file() }));

    proof.unreadable = true;
    await sync();

    expect(cb.onFileDeleted).not.toHaveBeenCalled();
    expect(cb.onSyncError).toHaveBeenCalledTimes(1);
    expect(state().fileCount).toBe(2);
  });

  it('does not report an unreadable subfolder or the files under it as deleted', async () => {
    const sub = dir({ 'a_proof.json': file(), deeper: dir({ 'b.c': file() }) });
    const { cb, sync, state } = await watch(dir({ sub }));

    sub.unreadable = true;
    await sync();

    expect(cb.onFileDeleted).not.toHaveBeenCalled();
    expect(cb.onFolderDeleted).not.toHaveBeenCalled();
    expect(cb.onSyncError).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ fileCount: 2, folderCount: 2 });
  });

  it('confirms no addition or modification from a round that could not read everything', async () => {
    const proof = file(1);
    const root = dir({ 'main_proof.json': proof, locked: file() });
    const { cb, sync } = await watch(root);

    proof.lastModified = 2;
    root.children['new.c'] = file();
    (root.children.locked as FakeFile).unreadable = true;
    await sync();

    expectNoChangeReported(cb);
    expect(cb.onSyncError).toHaveBeenCalledTimes(1);
  });

  it('reports the changes made during a failure once a later round reads everything', async () => {
    const proof = file(1);
    const root = dir({ 'main_proof.json': proof, 'gone.c': file(), old: dir({}) });
    const { cb, sync, state } = await watch(root);

    root.unreadable = true;
    proof.lastModified = 2;
    delete root.children['gone.c'];
    delete root.children.old;
    root.children['new.c'] = file();
    await sync();
    expectNoChangeReported(cb);

    root.unreadable = false;
    await sync();

    expect(cb.onFileModified).toHaveBeenCalledWith(expect.objectContaining({ path: 'main_proof.json' }));
    expect(cb.onFileAdded).toHaveBeenCalledWith(expect.objectContaining({ path: 'new.c' }));
    expect(cb.onFileDeleted).toHaveBeenCalledExactlyOnceWith('gone.c');
    expect(cb.onFolderDeleted).toHaveBeenCalledExactlyOnceWith('old');
    expect(cb.onSyncComplete).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ fileCount: 2, folderCount: 0 });
  });

  it('reports a file and a folder removed from a fully readable folder as deleted', async () => {
    const root = dir({ 'main_proof.json': file(), 'main.c': file(), sub: dir({ 'a.c': file() }) });
    const { cb, sync } = await watch(root);

    delete root.children['main.c'];
    delete root.children.sub;
    await sync();

    expect(cb.onFileDeleted).toHaveBeenCalledTimes(2);
    expect(cb.onFileDeleted).toHaveBeenCalledWith('main.c');
    expect(cb.onFileDeleted).toHaveBeenCalledWith('sub/a.c');
    expect(cb.onFolderDeleted).toHaveBeenCalledExactlyOnceWith('sub');
    expect(cb.onSyncError).not.toHaveBeenCalled();
    expect(cb.onSyncComplete).toHaveBeenCalledTimes(1);
  });
});
