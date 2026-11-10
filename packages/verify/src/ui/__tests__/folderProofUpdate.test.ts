// @vitest-environment happy-dom
/**
 * FSA フォルダの外部更新は「同じタブ ID での取り込み直し」(#695)。
 *
 * 監視中の proof が書き換わったら、表示する本文・イベント (proofData)・派生状態 (language / startTimestamp)・
 * 提出物照合の材料・検証結果を、新しい proof の 1 スナップショットに揃える。旧実装は status と結果だけを
 * 初期化して新しい rawData を検証に回し、古い本文と新しい検証結果を合成して表示していた。
 *
 * 実物の FolderController / FileController / FileProcessor / VerifyTabManager / Sidebar / TabBar /
 * VerificationController をつなぐ。更新は FolderController の監視コールバック (`handleExternalFileModified`)
 * から起こし、検証は `runProofVerification` を実際に呼んで `handleComplete` に渡す (Worker の代わり)。
 * 表示データは `buildResultData` で見る。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProcessor } from '../../services/FileProcessor.js';
import { runProofVerification } from '../../services/proofVerification.js';
import { buildResultData } from '../../services/ResultDataService.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import type { FSAccessFileEntry, QueueItem, VerifyTabState } from '../../types.js';
import { FileController } from '../controllers/FileController.js';
import { FolderController, type FolderControllerDependencies } from '../controllers/FolderController.js';
import {
  VerificationController,
  type VerificationControllerDependencies,
} from '../controllers/VerificationController.js';
import { Sidebar } from '../Sidebar.js';
import { TabBar } from '../TabBar.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

// happy-dom 環境では import.meta.url が file: にならないので、パッケージルート (= cwd) から引く。
const VALID = readFileSync(
  join(resolve(process.cwd(), '../verify-cli'), 'src/__tests__/fixtures/proofs/valid.json'),
  'utf-8'
);
/** 実 PoSW 付きの有効 proof (content === "ok"、filename `valid` / language `javascript`)。 */
const VALID_PROOF = JSON.parse(VALID) as Record<string, unknown>;
/** 本文だけを書き換えた proof。full 検証で valid === false になる。 */
const TAMPERED = JSON.stringify({ ...VALID_PROOF, content: 'TAMPERED OLD CONTENT' });
const PROOF_PATH = 'valid_proof.json';

/** FSA の FileSystemFileHandle の代わり (getFile だけ使われる)。 */
function entry(path: string, content: string): FSAccessFileEntry {
  const name = path.split('/').pop() ?? path;
  const handle = { getFile: async () => new File([content], name) } as unknown as FileSystemFileHandle;
  return { handle, path, name, lastModified: Date.now() };
}

/** 監視・初回読み込みの経路は FolderController の private メソッド。テストからはこの 2 つだけを呼ぶ。 */
interface FolderInternals {
  processFileFromHandle(fileEntry: FSAccessFileEntry, folderMap: Map<string, string>): Promise<void>;
  handleExternalFileModified(file: FSAccessFileEntry): Promise<void>;
}

function stack() {
  const tabManager = new VerifyTabManager();
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
  const uiState = new UIStateManager();

  /** 検証キューの代わり。待ち行列と呼び出しの順を記録し、`drain` で実際に検証する。 */
  const waiting = new Map<string, QueueItem>();
  const calls: string[] = [];
  const queue = {
    enqueue: (item: QueueItem) => {
      calls.push(`enqueue:${item.id}`);
      waiting.set(item.id, item);
    },
    remove: (id: string) => {
      calls.push(`remove:${id}`);
      waiting.delete(id);
    },
    reverifyWithManifest: vi.fn(),
  };

  const verification = new VerificationController({
    tabManager,
    sidebar,
    tabBar,
    uiState,
    statusBar: { setError: vi.fn() },
    resultPanel: { finishProgress: vi.fn(), errorProgress: vi.fn() },
    tabController: { showTabContent: vi.fn(), openTabForFile: vi.fn(), updateVerificationProgressUI: vi.fn() },
  } as unknown as VerificationControllerDependencies);

  let n = 0;
  const generateId = () => `t${++n}`;
  const statusBar = { setError: vi.fn(), setMessage: vi.fn() };
  const onFileReplaced = vi.fn();
  const files = new FileController({
    fileProcessor: new FileProcessor(),
    tabManager,
    uiState,
    verificationQueue: queue,
    sidebar,
    statusBar,
    generateId,
    tabBar,
    onSubmissionChange: (id: string) => verification.recomputeStatus(id),
    onFileReplaced,
  } as unknown as ConstructorParameters<typeof FileController>[0]);

  const folder = new FolderController({
    fileProcessor: new FileProcessor(),
    sidebar,
    statusBar: statusBar as unknown as FolderControllerDependencies['statusBar'],
    generateId,
    addFileToVerification: (...args) => files.addFileToVerification(...args),
    addPlaintextFile: (fileData, folderId) => files.addPlaintextFile(fileData, folderId),
    addImageFile: (fileData, folderId) => files.addImageFile(fileData, folderId),
    replaceFile: (id, fileData) => files.replaceFile(id, fileData),
    settleSubmission: () => files.settleSubmission(),
  } satisfies FolderControllerDependencies) as unknown as FolderInternals;

  sidebar.addFolder({ id: 'folder', name: 'folder', expanded: true });

  /** フォルダを開いたときと同じ経路で読み込む (全ファイルが揃ってから照合する)。 */
  async function open(entries: Record<string, string>): Promise<void> {
    const folderMap = new Map([['', 'folder']]);
    for (const [path, content] of Object.entries(entries)) {
      await folder.processFileFromHandle(entry(path, content), folderMap);
    }
    files.settleSubmission();
  }

  /** 監視が外部の書き換えを見つけたときと同じ経路で更新する。 */
  async function modify(path: string, content: string): Promise<void> {
    await folder.handleExternalFileModified(entry(path, content));
  }

  /** 待ち行列の proof を実際に full 検証し、結果を VerificationController に渡す (Worker の代わり)。 */
  async function drain(): Promise<void> {
    for (const [id, item] of [...waiting]) {
      waiting.delete(id);
      verification.handleComplete(id, await runProofVerification(JSON.parse(item.rawData), { mode: 'full' }));
    }
  }

  function tabAt(path: string): VerifyTabState {
    const id = sidebar.getFileIdByPath(path);
    const tab = id ? tabManager.getTab(id) : undefined;
    if (!tab) throw new Error(`no tab for ${path}`);
    return tab;
  }

  /** `data-filename` (表示名) → サイドバーの status (状態契約)。 */
  function statuses(): Record<string, string | undefined> {
    return Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('#file-list .file-item')].map((el) => [
        el.dataset.filename ?? '',
        el.dataset.status,
      ])
    );
  }

  return { files, uiState, waiting, calls, statusBar, onFileReplaced, open, modify, drain, tabAt, statuses };
}

beforeEach(() => {
  mountVerifyIndexHtml();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('external proof update in a watched folder (#695)', () => {
  it('shows the content, events and verification result of the new proof after a tampered proof is replaced by a valid one', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: TAMPERED });
    await s.drain();
    expect(s.tabAt(PROOF_PATH).verificationResult?.valid).toBe(false);

    await s.modify(PROOF_PATH, VALID);
    await s.drain();

    const tab = s.tabAt(PROOF_PATH);
    const shown = buildResultData(tab)!;
    expect(tab.verificationResult?.valid).toBe(true);
    expect(shown.result.chainValid).toBe(true);
    expect(shown.content).toBe('ok');
    expect(tab.proofData).toEqual(VALID_PROOF);
    expect(shown.eventCount).toBe((VALID_PROOF.proof as { events: unknown[] }).events.length);
  });

  it('shows the tampered content with a failed result after a valid proof is replaced by a tampered one, with nothing left of the old proof', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID });
    await s.drain();
    expect(s.tabAt(PROOF_PATH).verificationResult?.valid).toBe(true);

    await s.modify(PROOF_PATH, TAMPERED);
    await s.drain();

    const tab = s.tabAt(PROOF_PATH);
    const shown = buildResultData(tab)!;
    expect(tab.verificationResult?.valid).toBe(false);
    expect(shown.content).toBe('TAMPERED OLD CONTENT');
    expect(JSON.stringify(tab)).not.toContain('"content":"ok"');
    expect(s.statuses()[PROOF_PATH]).toBe('error');
  });

  it('re-derives language and startTimestamp from the new proof', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID });
    const before = s.tabAt(PROOF_PATH);
    expect(before.language).toBe('javascript');

    const timestamp = '2030-01-02T03:04:05.000Z';
    await s.modify(
      PROOF_PATH,
      JSON.stringify({
        ...VALID_PROOF,
        language: 'python',
        metadata: { ...(VALID_PROOF.metadata as object), timestamp },
      })
    );

    const after = s.tabAt(PROOF_PATH);
    expect(after.id).toBe(before.id);
    expect(after.language).toBe('python');
    const events = (VALID_PROOF.proof as { events: Array<{ timestamp: number }> }).events;
    expect(after.startTimestamp).toBe(new Date(timestamp).getTime() - events[events.length - 1]!.timestamp);
    expect(after.startTimestamp).not.toBe(before.startTimestamp);
  });

  it('re-checks the bundled source against the new proof content when the proof is updated', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: JSON.stringify({ ...VALID_PROOF, content: 'something else' }), 'valid.js': 'ok' });
    await s.drain();
    expect(s.statuses()).toMatchObject({ [PROOF_PATH]: 'error', 'valid.js': 'error' });

    await s.modify(PROOF_PATH, VALID);
    expect(s.tabAt(PROOF_PATH).associatedSourceMismatch).toBeUndefined();
    await s.drain();

    expect(s.statuses()[PROOF_PATH]).not.toBe('error');
    expect(s.statuses()['valid.js']).toBe('success');
  });

  it('re-checks the proof against the bundled source when the source is updated', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID, 'valid.js': 'ok' });
    await s.drain();
    expect(s.statuses()['valid.js']).toBe('success');

    await s.modify('valid.js', 'tampered source');

    expect(s.tabAt('valid.js').plaintextContent).toBe('tampered source');
    expect(s.tabAt(PROOF_PATH).associatedSourceMismatch).toMatchObject({ kind: 'mismatch', severity: 'error' });
    expect(s.statuses()).toMatchObject({ [PROOF_PATH]: 'error', 'valid.js': 'error' });
  });

  it('turns a proof replaced by broken JSON into an error tab without proof data and keeps it off the queue', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID });
    await s.drain();

    await s.modify(PROOF_PATH, '{"proof":');

    const tab = s.tabAt(PROOF_PATH);
    expect(tab.status).toBe('error');
    expect(tab.proofData).toBeNull();
    expect(tab.verificationResult).toBeNull();
    expect(tab.error).toBeTruthy();
    expect(s.waiting.size).toBe(0);
    expect(s.statuses()[PROOF_PATH]).toBe('error');
  });

  it('loads and verifies a readable proof that replaces an unreadable one', async () => {
    const s = stack();
    // フォルダの JSON 読み込みは壊れた JSON を平文に落とすので、proof として読めなかったタブは FileController から作る
    s.files.addFileToVerification(PROOF_PATH, '{"proof":', 'folder', PROOF_PATH);
    expect(s.tabAt(PROOF_PATH).status).toBe('error');

    await s.modify(PROOF_PATH, VALID);
    expect(s.tabAt(PROOF_PATH).proofData).toEqual(VALID_PROOF);
    expect(s.tabAt(PROOF_PATH).error).toBeUndefined();
    await s.drain();

    expect(s.tabAt(PROOF_PATH).verificationResult?.valid).toBe(true);
    expect(buildResultData(s.tabAt(PROOF_PATH))?.content).toBe('ok');
  });

  it('matches the bundled sources again once an unreadable proof becomes readable, without a stale unreadable entry', async () => {
    const s = stack();
    // 同名タブの 1 つ目が読めないと、2 つ目 (valid_proof_1.json) のソース名が確定できず曖昧 (error) になる
    s.files.addFileToVerification(PROOF_PATH, '{"proof":', 'folder', PROOF_PATH);
    await s.open({ 'valid_proof_1.json': VALID, 'valid.js': 'ok', 'valid_1.js': 'ok' });
    await s.drain();
    expect(s.statuses()['valid_proof_1.json']).toBe('error');

    await s.modify(PROOF_PATH, VALID);
    await s.drain();

    expect(s.tabAt('valid_proof_1.json').associatedSourceMismatch).toBeUndefined();
    expect(s.statuses()).toMatchObject({ 'valid.js': 'success', 'valid_1.js': 'success' });
  });

  it('stops matching the bundled source against a proof that became unreadable', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID, 'valid.js': 'ok' });
    await s.drain();
    expect(s.statuses()['valid.js']).toBe('success');

    await s.modify(PROOF_PATH, '{"proof":');

    // 読めない proof の期待名は分からないので、ソースはどの proof にも当たらない (孤立 = warning)
    expect(s.statuses()['valid.js']).toBe('warning');
  });

  it('replaces the image of a screenshot tab instead of reading it as text', async () => {
    const s = stack();
    await s.open({ 'screenshots/a.png': 'old image' });

    await s.modify('screenshots/a.png', 'new image');

    const tab = s.tabAt('screenshots/a.png');
    expect(tab.isImage).toBe(true);
    expect(await tab.imageBlob?.text()).toBe('new image');
    expect(tab.plaintextContent).toBeUndefined();
  });

  it('removes the in-flight verification of the old proof before queueing the new one', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: TAMPERED });
    const id = s.tabAt(PROOF_PATH).id;

    await s.modify(PROOF_PATH, VALID);

    expect(s.calls).toEqual([`enqueue:${id}`, `remove:${id}`, `enqueue:${id}`]);
    expect(s.waiting.get(id)?.rawData).toBe(VALID);
  });

  it('never lets the completed count exceed the total across repeated updates', async () => {
    const s = stack();
    const seen: Array<{ completed: number; total: number }> = [];
    const record = () => {
      const { completedCount, totalCount } = s.uiState.getState();
      seen.push({ completed: completedCount, total: totalCount });
    };

    // 済み → 検証中の更新 → 読めない → 読める → 済み → 済みの更新、と状態をまたいで更新する
    await s.open({ [PROOF_PATH]: VALID });
    await s.drain();
    record();
    for (const next of [TAMPERED, VALID, '{"proof":', VALID]) {
      await s.modify(PROOF_PATH, next);
      record();
    }
    await s.drain();
    record();
    await s.modify(PROOF_PATH, TAMPERED);
    record();
    await s.drain();
    record();

    for (const { completed, total } of seen) expect(completed).toBeLessThanOrEqual(total);
    // すべて済んだら N/M が揃う (揃わないと「検証中」の表示が終わらない)
    const last = seen.at(-1)!;
    expect(last.completed).toBe(last.total);
  });

  it('notifies the view so that an open tab is redrawn with the new proof', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: VALID });

    await s.modify(PROOF_PATH, TAMPERED);

    expect(s.onFileReplaced).toHaveBeenCalledWith(s.tabAt(PROOF_PATH).id);
  });
});
