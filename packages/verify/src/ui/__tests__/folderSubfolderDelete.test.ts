// @vitest-environment happy-dom
/**
 * 監視中にサブフォルダごと消える (#835)。消えたフォルダの配下のタブ・検証キュー・照合の材料、フォルダのスクショの
 * 読み直しの対象・読み込みに失敗した変更のやり直しの対象が残ってはいけない。
 *
 * フォルダの削除の通知 (`handleExternalFolderDeleted`) 自体はサイドバーの行を外すだけ。配下の後始末は、監視
 * (`FolderSyncManager.checkForChanges`) がフォルダの削除より先に、前回の走査にあった配下のファイルの削除を
 * 1 件ずつ通知し、ファイルの削除 (`handleExternalFileDeleted` → `onFileRemove`) を通ることで済んでいる。
 * このテストはその経路を固定する (監視がフォルダの削除だけを通知するようになると赤になる)。
 *
 * 組み立ては `folderStack` (実物のコントローラ群。削除は AppController と同じ外し方)。フォルダは `FakeFolder`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const EMPTY_MANIFEST = JSON.stringify({ version: '1.0', totalScreenshots: 0, screenshots: [] });

function rows(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#file-list .file-item')].map((el) => el.dataset.filename ?? '');
}

beforeEach(() => {
  mountVerifyIndexHtml();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopAllWatching();
});

describe('a subfolder of a watched folder is deleted (#835)', () => {
  it('removes the tabs, queued verifications and rows under the deleted subfolder and keeps the proof outside it', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', {
      'root_proof.json': VALID,
      'sub/sub_proof.json': VALID,
      'sub/valid.js': 'ok',
    });
    await s.folder.openFolder(fake.handle());
    const subProof = s.tabAt('sub/sub_proof.json').id;
    const subSource = s.tabAt('sub/valid.js').id;
    const rootProof = s.tabAt('root_proof.json').id;
    expect(s.waiting.has(subProof)).toBe(true);

    fake.remove('sub/sub_proof.json');
    fake.remove('sub/valid.js');
    await s.sync();

    expect(s.tabManager.getTab(subProof)).toBeFalsy();
    expect(s.tabManager.getTab(subSource)).toBeFalsy();
    expect(s.waiting.has(subProof)).toBe(false);
    expect(s.sidebar.getFolderIdByPath('sub')).toBeUndefined();
    expect(rows()).toEqual(['root_proof.json']);

    await s.drain();
    expect(s.tabManager.getTab(rootProof)?.verificationResult?.valid).toBe(true);
    expect(s.tabManager.getTab(rootProof)?.status).not.toBe('error');
  });

  it('does not bring back a proof or a failed change under the deleted subfolder on a later screenshot re-read or retry', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', {
      'screenshots/manifest.json': EMPTY_MANIFEST,
      'root_proof.json': VALID,
      'sub/sub_proof.json': VALID,
      'sub/notes.txt': 'notes',
    });
    // 開くときの一覧 (1 回目) には載るが、中身の読み込み (2 回目) に失敗する = やり直しの対象になる
    fake.beforeGetFile = (path, call) => {
      if (path === 'sub/notes.txt' && call === 2) throw new DOMException('busy', 'NotReadableError');
    };
    await s.folder.openFolder(fake.handle());
    expect(() => s.tabAt('sub/sub_proof.json')).not.toThrow();
    expect(() => s.tabAt('sub/notes.txt')).toThrow();

    fake.remove('sub/sub_proof.json');
    fake.remove('sub/notes.txt');
    await s.sync();
    // フォルダのスクショが変わる: スクショを渡した proof の取り込み直しが走る
    fake.write('screenshots/manifest.json', `${EMPTY_MANIFEST}\n`);
    await s.sync();
    await s.sync();

    // screenshots/ は閉じて開くので、manifest.json の行は描かれない (タブはある)
    expect(rows()).toEqual(['root_proof.json']);
    expect(
      s.tabManager
        .getAllTabs()
        .map((tab) => tab.filename)
        .sort()
    ).toEqual(['manifest.json', 'root_proof.json']);
  });
});
