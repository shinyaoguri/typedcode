// @vitest-environment happy-dom
/**
 * フォルダを開く・監視する操作の知らせで、ステータスバーの集約 (`#queue-status` の data-proof-*) を消さない (#683)。
 *
 * 集約を出し直す契機は検証の完了だけなので、検証が先に終わった後に「フォルダを開いた」などのメッセージで
 * 集約を上書きすると、集約は消えたまま二度と出ない。フォルダを開く処理の末尾 (監視の初期スナップショット) が
 * 検証より遅れたときに起きていた。
 *
 * 実物の FolderController / FileController / VerificationController / StatusBarUI をつなぎ、ステータスバーの
 * 表示は AppController と同じ `renderStatusBar` で決める。フォルダは FSA のハンドルの fake (`FakeFolder`)。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProcessor } from '../../services/FileProcessor.js';
import { runProofVerification } from '../../services/proofVerification.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import type { QueueItem } from '../../types.js';
import { FileController } from '../controllers/FileController.js';
import { FolderController } from '../controllers/FolderController.js';
import {
  VerificationController,
  type VerificationControllerDependencies,
} from '../controllers/VerificationController.js';
import { Sidebar } from '../Sidebar.js';
import { StatusBarUI } from '../StatusBarUI.js';
import { renderStatusBar } from '../statusBarView.js';
import { TabBar } from '../TabBar.js';
import { FakeFolder } from './fakeFolder.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

// happy-dom 環境では import.meta.url が file: にならないので、パッケージルート (= cwd) から引く。
const VALID = readFileSync(
  join(resolve(process.cwd(), '../verify-cli'), 'src/__tests__/fixtures/proofs/valid.json'),
  'utf-8'
);

/** 監視 (FolderSyncManager) はテストから 1 回ずつ回し、終わったら止める。 */
interface SyncInternals {
  syncManager: { forceSync(): Promise<void>; stopWatching(): void };
}

const opened: FolderController[] = [];

function stack() {
  const tabManager = new VerifyTabManager();
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
  const uiState = new UIStateManager();
  const statusBar = new StatusBarUI();

  /** AppController.updateStatusBar と同じ決め方 */
  const render = (message?: string) => renderStatusBar(statusBar, tabManager.getAllTabs(), uiState.getState(), message);

  const waiting = new Map<string, QueueItem>();
  const queue = {
    enqueue: (item: QueueItem) => waiting.set(item.id, item),
    remove: (id: string) => waiting.delete(id),
    reverifyWithManifest: vi.fn(),
  };

  const verification = new VerificationController({
    tabManager,
    sidebar,
    tabBar,
    uiState,
    statusBar,
    resultPanel: { finishProgress: vi.fn(), errorProgress: vi.fn() },
    tabController: { showTabContent: vi.fn(), openTabForFile: vi.fn(), updateVerificationProgressUI: vi.fn() },
  } as unknown as VerificationControllerDependencies);

  let n = 0;
  const generateId = () => `t${++n}`;
  const files = new FileController({
    fileProcessor: new FileProcessor(),
    tabManager,
    uiState,
    verificationQueue: queue,
    sidebar,
    statusBar,
    generateId,
    tabBar,
    onStatusBarUpdate: () => render(),
    onSubmissionChange: (id: string) => verification.recomputeStatus(id),
  } as unknown as ConstructorParameters<typeof FileController>[0]);

  const folder = new FolderController({
    fileProcessor: new FileProcessor(),
    sidebar,
    statusBar,
    generateId,
    addFileToVerification: (...args) => files.addFileToVerification(...args),
    addPlaintextFile: (fileData, folderId) => files.addPlaintextFile(fileData, folderId),
    addImageFile: (fileData, folderId) => files.addImageFile(fileData, folderId),
    replaceFile: (id, fileData) => files.replaceFile(id, fileData),
    settleSubmission: () => files.settleSubmission(),
    onStatusBarUpdate: (message) => render(message),
  });
  opened.push(folder);

  /** 待ち行列の proof を実際に検証して完了を渡す (Worker の代わり)。完了後のステータスバー更新も AppController と同じ。 */
  async function drain(): Promise<void> {
    for (const [id, item] of [...waiting]) {
      waiting.delete(id);
      verification.handleComplete(id, await runProofVerification(JSON.parse(item.rawData), { mode: 'fast' }));
      render();
    }
  }

  async function sync(): Promise<void> {
    await (folder as unknown as SyncInternals).syncManager.forceSync();
  }

  return { folder, waiting, drain, sync };
}

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
  for (const folder of opened.splice(0)) (folder as unknown as SyncInternals).syncManager.stopWatching();
});

describe('status bar summary around opening a folder (#683)', () => {
  it('keeps the proof summary when verification finishes before opening the folder completes', async () => {
    const s = stack();
    const fake = new FakeFolder('submissions', { 'valid_proof.json': VALID });
    // 監視の初期スナップショット (ルートの 2 回目の走査) を、検証が終わるまで止める
    let reached!: () => void;
    const snapshotReached = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const snapshotReleased = new Promise<void>((r) => (release = r));
    fake.beforeRootValues = (call) => {
      if (call !== 2) return;
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
    const s = stack();
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
    const s = stack();
    await s.folder.openFolder(new FakeFolder('notes-only', { 'readme.txt': 'hello' }).handle());

    expect(proofAttrs()).toEqual({ total: undefined, passed: undefined, failed: undefined, cancelled: undefined });
    expect(document.getElementById('queue-status')!.textContent).toContain('notes-only');
  });
});
