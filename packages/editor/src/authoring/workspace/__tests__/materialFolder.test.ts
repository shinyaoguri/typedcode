/**
 * MaterialFolder のテスト (#795 / ADR-0051 Decision 10)。
 *
 * メモリ上の fake フォルダ (`fakeDirectoryHandle.ts`) で、列挙・読み込み・保存と、外部での変更を上書きしない
 * こと、書き込みの失敗を結果で返して元の内容を壊さないことを固定する。`lastModified` は fake の決定的な時計。
 */

import { describe, expect, it } from 'vitest';
import { InvalidFolderPathError, MaterialFolder, splitFolderPath } from '../materialFolder.js';
import { FakeFileSystem } from './fakeDirectoryHandle.js';

const PROBLEM = '最大値.problem.yaml';
const NESTED = '過去問/探索.problem.yaml';

function setup(files: Record<string, string> = { [PROBLEM]: 'format: tc-problem/1\n', [NESTED]: 'id: 探索\n' }) {
  const fs = new FakeFileSystem('教材', files);
  return { fs, folder: new MaterialFolder(fs.root()) };
}

describe('MaterialFolder listing and saving', () => {
  it('lists files in subfolders as root-relative POSIX paths and skips dot-prefixed entries', async () => {
    const { folder } = setup({
      [PROBLEM]: 'a',
      [NESTED]: 'b',
      '.git/config': 'x',
      '過去問/.DS_Store': 'y',
    });
    expect(await folder.listFiles()).toEqual([NESTED, PROBLEM].sort());
  });

  it('reports the folder name of the handle', () => {
    const { folder } = setup();
    expect(folder.name).toBe('教材');
  });

  it('saving a text file that was read replaces its content', async () => {
    const { fs, folder } = setup();
    await folder.readText(NESTED);
    const result = await folder.writeText(NESTED, 'id: 探索\ntitle: 二分探索\n');
    expect(result.status).toBe('saved');
    expect(fs.readFile(NESTED)).toBe('id: 探索\ntitle: 二分探索\n');
  });

  it('consecutive saves do not conflict with the folder object itself', async () => {
    const { folder } = setup();
    await folder.readText(PROBLEM);
    await folder.writeText(PROBLEM, 'v1');
    expect((await folder.writeText(PROBLEM, 'v2')).status).toBe('saved');
  });

  it('creates a new file together with its missing intermediate folders', async () => {
    const { fs, folder } = setup({});
    const result = await folder.writeText('新しい/問題/a.md', '# a\n');
    expect(result.status).toBe('saved');
    expect(fs.readFile('新しい/問題/a.md')).toBe('# a\n');
  });

  it('creates nested folders', async () => {
    const { fs, folder } = setup({});
    expect((await folder.createFolder('a/b')).status).toBe('created');
    expect(fs.hasFolder('a/b')).toBe(true);
  });

  it('exists is true for a file and false for a missing file or a folder', async () => {
    const { folder } = setup();
    expect([await folder.exists(NESTED), await folder.exists('無い.md'), await folder.exists('過去問')]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('rejects paths that are absolute, empty-segmented or leave the folder', () => {
    for (const path of ['', '/a.md', 'a//b.md', 'a/', '../a.md', 'a/./b.md', 'a\\b.md']) {
      expect(() => splitFolderPath(path), path).toThrow(InvalidFolderPathError);
    }
  });
});

describe('MaterialFolder external changes', () => {
  it('does not write a file whose lastModified advanced after it was read and returns a conflict', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.writeExternally(PROBLEM, 'changed elsewhere');
    const result = await folder.writeText(PROBLEM, 'mine');
    expect(result).toMatchObject({ status: 'conflict', reason: 'modified' });
    expect(fs.readFile(PROBLEM)).toBe('changed elsewhere');
  });

  it('treats an advanced lastModified as a conflict even when the content is unchanged', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.touch(PROBLEM);
    expect(await folder.writeText(PROBLEM, 'mine')).toMatchObject({ status: 'conflict', reason: 'modified' });
  });

  it('overwrite writes despite the external change', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.writeExternally(PROBLEM, 'changed elsewhere');
    expect((await folder.writeText(PROBLEM, 'mine', { overwrite: true })).status).toBe('saved');
    expect(fs.readFile(PROBLEM)).toBe('mine');
  });

  it('does not overwrite an existing file that this folder object never read', async () => {
    const { fs, folder } = setup();
    expect(await folder.writeText(PROBLEM, 'mine')).toMatchObject({ status: 'conflict', reason: 'exists' });
    expect(fs.readFile(PROBLEM)).toBe('format: tc-problem/1\n');
  });

  it('does not recreate a file that was deleted after it was read', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.deleteExternally(PROBLEM);
    expect(await folder.writeText(PROBLEM, 'mine')).toMatchObject({ status: 'conflict', reason: 'deleted' });
    expect(fs.readFile(PROBLEM)).toBeUndefined();
  });

  it('createFile refuses to replace a file that already exists even after reading it', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    expect(await folder.createFile(PROBLEM, 'mine')).toMatchObject({ status: 'conflict', reason: 'exists' });
    expect(fs.readFile(PROBLEM)).toBe('format: tc-problem/1\n');
  });
});

describe('MaterialFolder write failures', () => {
  it('returns failed instead of throwing when write throws', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    const error = new DOMException('disk is gone', 'InvalidStateError');
    fs.failWrites = (_path, stage) => (stage === 'write' ? error : undefined);
    expect(await folder.writeText(PROBLEM, 'mine')).toEqual({ status: 'failed', path: PROBLEM, cause: error });
  });

  it('a failed write leaves the original file untouched', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.failWrites = (_path, stage) => (stage === 'close' ? new Error('close failed') : undefined);
    await folder.writeText(PROBLEM, 'mine');
    expect(fs.readFile(PROBLEM)).toBe('format: tc-problem/1\n');
  });

  it('the unsaved text can be saved again once the fault is gone', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.failWrites = () => new DOMException('permission revoked', 'NotAllowedError');
    await folder.writeText(PROBLEM, 'mine');
    fs.failWrites = undefined;
    expect((await folder.writeText(PROBLEM, 'mine')).status).toBe('saved');
    expect(fs.readFile(PROBLEM)).toBe('mine');
  });

  it('a new file whose first write failed can be saved again without a conflict', async () => {
    const { fs, folder } = setup({});
    fs.failWrites = (_path, stage) => (stage === 'write' ? new Error('write failed') : undefined);
    await folder.writeText('a.md', 'mine');
    fs.failWrites = undefined;
    expect((await folder.writeText('a.md', 'mine')).status).toBe('saved');
  });

  it('returns failed when permission was revoked before saving', async () => {
    const { fs, folder } = setup();
    await folder.readText(PROBLEM);
    fs.permission = 'prompt';
    expect((await folder.writeText(PROBLEM, 'mine')).status).toBe('failed');
  });

  it('returns failed for an invalid path instead of throwing', async () => {
    const { folder } = setup();
    expect(await folder.writeText('../outside.md', 'x')).toMatchObject({ status: 'failed' });
  });
});
