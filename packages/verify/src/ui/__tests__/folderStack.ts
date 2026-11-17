/**
 * FSA フォルダを開く・監視する経路の UI テスト用の組み立て (#683 / #703)。
 *
 * 実物の FolderController / FileController / FileProcessor / VerifyTabManager / Sidebar / TabBar /
 * VerificationController / StatusBarUI をつなぐ。ステータスバーの表示は AppController と同じ `renderStatusBar`
 * で決める。検証キューは記録するだけの fake で、`drain` が `runProofVerification` を実際に呼んで
 * `handleComplete` に渡す (Worker の代わり)。監視 (FolderSyncManager) はポーリングに任せず `sync` で 1 回ずつ回す。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';
import { FileProcessor } from '../../services/FileProcessor.js';
import { runProofVerification } from '../../services/proofVerification.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import type { QueueItem, VerifyTabState } from '../../types.js';
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

/**
 * 実 PoSW 付きの有効 proof (content === "ok"、filename `valid` / language `javascript`。スクショの記録は無い)。
 * happy-dom 環境では import.meta.url が file: にならないので、パッケージルート (= cwd) から引く。
 */
export const VALID = readFileSync(
  join(resolve(process.cwd(), '../verify-cli'), 'src/__tests__/fixtures/proofs/valid.json'),
  'utf-8'
);

/** 監視 (FolderSyncManager) はテストから 1 回ずつ回し、終わったら止める。 */
interface SyncInternals {
  syncManager: { forceSync(): Promise<void>; stopWatching(): void };
}

const opened: FolderController[] = [];

/** `afterEach` で呼ぶ。開いたフォルダの監視 (setInterval) を止める。 */
export function stopAllWatching(): void {
  for (const folder of opened.splice(0)) (folder as unknown as SyncInternals).syncManager.stopWatching();
}

export function folderStack() {
  const tabManager = new VerifyTabManager();
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
  const uiState = new UIStateManager();
  const statusBar = new StatusBarUI();

  /** AppController.updateStatusBar と同じ決め方 */
  const render = (message?: string) => renderStatusBar(statusBar, tabManager.getAllTabs(), uiState.getState(), message);

  /** 検証キューの代わり。待ち行列と、検証に回した id の順を記録する。 */
  const waiting = new Map<string, QueueItem>();
  const enqueued: string[] = [];
  const queue = {
    enqueue: (item: QueueItem) => {
      enqueued.push(item.id);
      waiting.set(item.id, item);
    },
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
    replaceFile: (id, fileData, container) => files.replaceFile(id, fileData, container),
    settleSubmission: () => files.settleSubmission(),
    onStatusBarUpdate: (message) => render(message),
  });
  opened.push(folder);

  /** 待ち行列の proof を実際に検証して完了を渡す。完了後のステータスバー更新も AppController と同じ。 */
  async function drain(): Promise<void> {
    for (const [id, item] of [...waiting]) {
      waiting.delete(id);
      verification.handleComplete(id, await runProofVerification(JSON.parse(item.rawData), { mode: 'fast' }));
      render();
    }
  }

  /** 監視を 1 回回し、その走査が予約したスクショの読み直し (#703) の終わりまで待つ。 */
  async function sync(): Promise<void> {
    await (folder as unknown as SyncInternals).syncManager.forceSync();
    await folder.whenScreenshotsResynced();
  }

  function tabAt(path: string): VerifyTabState {
    const id = sidebar.getFileIdByPath(path);
    const tab = id ? tabManager.getTab(id) : undefined;
    if (!tab) throw new Error(`no tab for ${path}`);
    return tab;
  }

  return { folder, waiting, enqueued, drain, sync, tabAt };
}
