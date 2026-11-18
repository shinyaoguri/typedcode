/**
 * 問題を別の教材フォルダへコピーする操作の、画面に依らない部分のテスト (#800)。
 *
 * コピーの規則そのもの (衝突・欠損・書く順) は copyProblem.test.ts が固定する。ここでは、未保存の編集があれば
 * 止めること、コピー元に保存済みの内容 (`AuthorWorkspace.reader()`) を使うこと、同じフォルダかの判定を固定する。
 */

import { describe, expect, it } from 'vitest';
import { AuthorWorkspace } from '../authorWorkspace.js';
import { MaterialFolder } from '../materialFolder.js';
import { copyProblemToFolder, isSameFolder, problemCopyBlocker } from '../problemCopy.js';
import { FakeFileSystem } from './fakeDirectoryHandle.js';

const MATERIAL: Record<string, string> = {
  '最大値.problem.yaml': 'format: tc-problem/1\nid: 最大値\nstatement: 最大値.md\nsolutions: [最大値-解答.c]\n',
  '最大値.md': '# 最大値\n',
  '最大値-解答.c': 'int main(void) { return 8; }\n',
  '合計.problem.yaml': 'format: tc-problem/1\nid: 合計\nstatement: 合計.md\n',
  '合計.md': '# 合計\n',
  '壊れた.problem.yaml': 'format: tc-problem/99\n',
};

async function setup() {
  const source = new FakeFileSystem('教材', MATERIAL);
  const folder = new MaterialFolder(source.root());
  const workspace = new AuthorWorkspace(folder);
  await workspace.refresh();
  const destination = new FakeFileSystem('共有');
  return { source, workspace, destination, destinationFolder: new MaterialFolder(destination.root()) };
}

async function edit(workspace: AuthorWorkspace, path: string, text: string): Promise<void> {
  const opened = await workspace.open(path);
  if (!opened.ok) throw new Error(`cannot open ${path}`);
  workspace.setText(path, text);
}

describe('problemCopyBlocker', () => {
  it('stops the copy when the problem definition itself has unsaved edits', async () => {
    const { workspace } = await setup();
    await edit(workspace, '最大値.problem.yaml', 'format: tc-problem/1\n');
    expect(problemCopyBlocker(workspace, '最大値.problem.yaml')).toEqual({
      status: 'dirty',
      paths: ['最大値.problem.yaml'],
    });
  });

  it('stops the copy when a referenced file has unsaved edits', async () => {
    const { workspace } = await setup();
    await edit(workspace, '最大値-解答.c', 'int main(void) { return 0; }\n');
    expect(problemCopyBlocker(workspace, '最大値.problem.yaml')).toEqual({
      status: 'dirty',
      paths: ['最大値-解答.c'],
    });
  });

  it('does not stop the copy for unsaved edits in files the problem does not reference', async () => {
    const { workspace } = await setup();
    await edit(workspace, '合計.md', '# 合計 (編集中)\n');
    expect(problemCopyBlocker(workspace, '最大値.problem.yaml')).toBeNull();
  });

  it('refuses to copy a problem whose definition cannot be read', async () => {
    const { workspace } = await setup();
    expect(problemCopyBlocker(workspace, '壊れた.problem.yaml')).toEqual({
      status: 'unknown-problem',
      path: '壊れた.problem.yaml',
    });
  });
});

describe('copyProblemToFolder', () => {
  it('writes nothing to the destination while the problem has unsaved edits', async () => {
    const { workspace, destination, destinationFolder } = await setup();
    await edit(workspace, '最大値.md', '# 最大値 (編集中)\n');
    const outcome = await copyProblemToFolder(workspace, '最大値.problem.yaml', destinationFolder);
    expect([outcome, destination.snapshot()]).toEqual([{ status: 'dirty', paths: ['最大値.md'] }, {}]);
  });

  it('copies the saved text of an open document without re-reading its file, so a later save still detects an external change', async () => {
    const { source, workspace, destination, destinationFolder } = await setup();
    await workspace.open('最大値.md');
    // 開いた後に外部で変わった (画面はまだ読んでいない)
    source.writeExternally('最大値.md', '# 外部で変えた本文\n');

    const outcome = await copyProblemToFolder(workspace, '最大値.problem.yaml', destinationFolder);
    workspace.setText('最大値.md', '# 手元の編集\n');
    const saved = await workspace.save('最大値.md');

    expect([outcome.status, destination.readFile('最大値.md'), saved.status]).toEqual([
      'copied',
      '# 最大値\n',
      'conflict',
    ]);
  });

  it('returns a failure without writing when the source folder cannot be listed again', async () => {
    const { source, workspace, destination, destinationFolder } = await setup();
    source.removeFolder();
    const outcome = await copyProblemToFolder(workspace, '最大値.problem.yaml', destinationFolder);
    expect([outcome.status, outcome.status === 'failed' && outcome.written, destination.snapshot()]).toEqual([
      'failed',
      [],
      {},
    ]);
  });

  it('copies the definition and its references with the same relative paths and unchanged text', async () => {
    const { workspace, destination, destinationFolder } = await setup();
    const outcome = await copyProblemToFolder(workspace, '最大値.problem.yaml', destinationFolder);
    expect([outcome, destination.snapshot()]).toEqual([
      { status: 'copied', written: ['最大値.md', '最大値-解答.c', '最大値.problem.yaml'] },
      {
        '最大値-解答.c': MATERIAL['最大値-解答.c'],
        '最大値.md': MATERIAL['最大値.md'],
        '最大値.problem.yaml': MATERIAL['最大値.problem.yaml'],
      },
    ]);
  });
});

describe('isSameFolder', () => {
  it('answers whether two handles are the same folder when the handle can tell', async () => {
    const fs = new FakeFileSystem('教材');
    const root = fs.root();
    expect([await isSameFolder(root, root), await isSameFolder(root, new FakeFileSystem('別').root())]).toEqual([
      true,
      false,
    ]);
  });

  it('answers unknown when the handle cannot compare entries', async () => {
    const plain = { kind: 'directory', name: 'x' } as unknown as FileSystemDirectoryHandle;
    expect(await isSameFolder(plain, plain)).toBeNull();
  });
});
