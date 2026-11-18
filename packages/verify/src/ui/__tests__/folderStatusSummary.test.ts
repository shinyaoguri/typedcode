// @vitest-environment happy-dom
/**
 * フォルダを開く・監視する操作の知らせで、ステータスバーの集約 (`#queue-status` の data-proof-*) を消さない (#683)。
 *
 * 集約を出し直す契機は検証の完了だけなので、検証が先に終わった後に「フォルダを開いた」などのメッセージで
 * 集約を上書きすると、集約は消えたまま二度と出ない。フォルダを開く処理の末尾が検証より遅れたときに起きていた
 * (当時の末尾は監視の初期スナップショット。#734 で監視は開いたときの一覧を基準にし、始めるときに走査しなくなった)。
 *
 * 組み立ては `folderStack` (実物の FolderController / FileController / VerificationController / StatusBarUI。
 * ステータスバーの表示は AppController と同じ `renderStatusBar`)。フォルダは FSA のハンドルの fake (`FakeFolder`)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

function proofAttrs() {
  const { proofTotal, proofPassed, proofFailed, proofCancelled } = document.getElementById('queue-status')!.dataset;
  return { total: proofTotal, passed: proofPassed, failed: proofFailed, cancelled: proofCancelled };
}

const PASSED_ONE = { total: '1', passed: '1', failed: '0', cancelled: '0' };

beforeEach(() => {
  mountVerifyIndexHtml();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopAllWatching();
});

describe('status bar summary around opening a folder (#683)', () => {
  it('keeps the proof summary when verification finishes before opening the folder completes', async () => {
    const s = folderStack();
    // 開く処理で最後に読むファイル (平文。名前の順で proof の後) の読み込みを、検証が終わるまで止める。
    // 監視は開いたときの一覧を基準にして走査しない (#734) ので、末尾を遅らせるのはここになる
    const fake = new FakeFolder('submissions', { 'valid_proof.json': VALID, 'zz_notes.txt': 'notes' });
    let reached!: () => void;
    const snapshotReached = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const snapshotReleased = new Promise<void>((r) => (release = r));
    fake.beforeGetFile = (path, call) => {
      // 1 回目は一覧の読み取り、2 回目が中身の読み込み
      if (path !== 'zz_notes.txt' || call !== 2) return;
      reached();
      return snapshotReleased;
    };

    const opening = s.folder.openFolder(fake.handle());
    await snapshotReached;
    await s.drain();
    expect(proofAttrs()).toEqual(PASSED_ONE);
    release();
    await opening;

    expect(proofAttrs()).toEqual(PASSED_ONE);
  });

  it('keeps the proof summary when the watcher picks up an added file after verification finished', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', { 'valid_proof.json': VALID });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    expect(proofAttrs()).toEqual(PASSED_ONE);

    fake.write('notes/readme.txt', 'hello');
    await s.sync();

    await vi.waitFor(() => expect(document.querySelector('#file-list [data-filename="readme.txt"]')).not.toBeNull());
    expect(proofAttrs()).toEqual(PASSED_ONE);
  });

  it('shows the folder-opened message when the folder has no proof to summarize', async () => {
    await folderStack().folder.openFolder(new FakeFolder('notes-only', { 'readme.txt': 'hello' }).handle());

    expect(proofAttrs()).toEqual({ total: undefined, passed: undefined, failed: undefined, cancelled: undefined });
    expect(document.getElementById('queue-status')!.textContent).toContain('notes-only');
  });
});
