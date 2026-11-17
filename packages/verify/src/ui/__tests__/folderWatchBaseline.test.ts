// @vitest-environment happy-dom
/**
 * フォルダの監視は、開いたときに実際に読み込んだ一覧を基準にする (#734)。
 *
 * 以前は監視を始めるときに改めて走査して基準を作り、その走査で読めなかったファイルを基準から黙って抜いていた。
 * 次に読めた回にそのファイルを「追加」と通知し、開いたときに読み込んだタブと重ねていた。逆に、開くときに読めずに
 * 飛ばしたファイルが基準の走査で読めると、一覧に出ないまま残っていた。
 *
 * 組み立ては `folderStack` (実物の FolderController / FileController / VerificationController)。
 * フォルダは FSA のハンドルの fake (`FakeFolder`)。開くときの proof の `getFile()` は、一覧・チェーン側の imageHash 集合
 * (スクショの裏付け)・中身の読み込みの 3 回。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const denied = () => new DOMException('permission temporarily denied', 'NotAllowedError');

function fileRows(filename: string): number {
  return document.querySelectorAll(`#file-list .file-item[data-filename="${filename}"]`).length;
}

beforeEach(() => {
  mountVerifyIndexHtml();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopAllWatching();
});

describe('folder watch baseline (#734)', () => {
  it('keeps a single row for a loaded proof that was momentarily unreadable right after the folder was opened', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', { 'valid_proof.json': VALID });
    // 開くときの 3 回の読み取りの直後 (以前は監視の基準の走査、いまは監視の最初の走査) だけ読めない
    fake.beforeGetFile = (path, call) => {
      if (path === 'valid_proof.json' && call === 4) throw denied();
    };
    await s.folder.openFolder(fake.handle());

    await s.sync();
    await s.sync();

    expect(fileRows('valid_proof.json')).toBe(1);
    expect(s.enqueued).toHaveLength(1);
  });

  it('loads a proof that could not be read when the folder was opened on the next watch round', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', { 'a_proof.json': VALID, 'b_proof.json': VALID });
    // 開くときの一覧の読み取り (strict の 1 回目と、飛ばして読み直す 2 回目。#773) でだけ読めない (飛ばされる)
    fake.beforeGetFile = (path, call) => {
      if (path === 'b_proof.json' && call <= 2) throw denied();
    };
    await s.folder.openFolder(fake.handle());
    expect(fileRows('b_proof.json')).toBe(0);

    await s.sync();

    await vi.waitFor(() => expect(fileRows('b_proof.json')).toBe(1));
    expect(fileRows('a_proof.json')).toBe(1);
    // 一覧が不完全だった間のスクショの判定を揃えるため同じタブで検証し直すことはある (#773) が、タブは 2 つのまま
    expect(new Set(s.enqueued).size).toBe(2);
  });
});
