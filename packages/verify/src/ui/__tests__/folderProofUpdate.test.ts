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
import { t } from '../../i18n/index.js';
import { FileProcessor } from '../../services/FileProcessor.js';
import type { FolderSyncManager } from '../../services/FolderSyncManager.js';
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

/** 監視・初回読み込みの経路は FolderController の private メンバー。テストからはこれだけを触る。 */
interface FolderInternals {
  processFileFromHandle(fileEntry: FSAccessFileEntry, folderMap: Map<string, string>): Promise<void>;
  handleExternalFileAdded(file: FSAccessFileEntry): Promise<void>;
  handleExternalFileModified(file: FSAccessFileEntry): Promise<void>;
  handleSyncComplete(): void;
  syncManager: FolderSyncManager;
}

/**
 * `getFile()` の読み取りを手で進める FSA のファイル。呼ばれるたびに `reads` の次の手順で読む: 文字列はその内容を
 * すぐ返し、`'fail'` は読み取りの失敗、`'hold'` は `release(content)` されるまで止めてからその内容を返す
 * (`release('fail')` なら読み取りの失敗)。
 * 呼ばれた時点の内容を返すのは実物と同じ (`getFile()` はその時点のスナップショット)。
 */
function scriptedEntry(path: string, reads: Array<string | 'fail' | 'hold'>) {
  const name = path.split('/').pop() ?? path;
  const held: Array<(content: string) => void> = [];
  let call = 0;
  const handle = {
    getFile: async () => {
      const step = reads[Math.min(call++, reads.length - 1)];
      if (step === 'fail') throw new DOMException('file is busy', 'NotReadableError');
      const content = step === 'hold' ? await new Promise<string>((resolve) => held.push(resolve)) : step!;
      if (content === 'fail') throw new DOMException('file is busy', 'NotReadableError');
      return new File([content], name);
    },
  } as unknown as FileSystemFileHandle;
  const entry: FSAccessFileEntry = { handle, path, name, lastModified: Date.now() };
  /** 止めている読み取りを、古い順に 1 本ずつ `content` で終わらせる */
  const release = (content: string) => held.shift()?.(content);
  /** 止めている読み取りがあるか (読み取りが getFile() まで進んだか) */
  const holding = () => held.length > 0;
  return { entry, release, holding };
}

/** 止めた読み込みが getFile() に入るまで待つ */
async function untilHeld(holding: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(holding()).toBe(true));
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
  const onStatusBarUpdate = vi.fn();
  /** 監視が削除を通知したときに AppController がする外し方 (tabManager とサイドバーから)。 */
  const onFileRemove = vi.fn((id: string) => {
    tabManager.removeTab(id);
    sidebar.removeFile(id);
  });
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
    onStatusBarUpdate,
    onFileRemove,
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

  return {
    files,
    folder,
    sidebar,
    uiState,
    waiting,
    calls,
    statusBar,
    onFileReplaced,
    onStatusBarUpdate,
    onFileRemove,
    open,
    modify,
    drain,
    tabAt,
    statuses,
  };
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

/**
 * 同じパスの読み込みが重なる (#787)。監視の通知・読み込みに失敗した変更のやり直しは、同じパスについて直列では
 * ない。先に始めた読み込み (古い内容) が後から終わっても、後に始めた読み込み (新しい内容) の結果を上書きしない。
 * 順序はタイマーではなく、止めた getFile() を手で終わらせて作る。
 */
describe('overlapping loads of the same path in a watched folder (#787)', () => {
  /** 本文が "ok" の proof と、それを書き換えた古い内容の proof (検証は失敗する) */
  const OLDER = TAMPERED;
  const NEWER = VALID;

  it('keeps the newer content and result when an older modification finishes after a newer one', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: JSON.stringify({ ...VALID_PROOF, content: 'initial' }) });
    const older = scriptedEntry(PROOF_PATH, ['hold']);

    const olderLoad = s.folder.handleExternalFileModified(older.entry);
    await untilHeld(older.holding);
    await s.folder.handleExternalFileModified(scriptedEntry(PROOF_PATH, [NEWER]).entry);
    older.release(OLDER);
    await olderLoad;
    await s.drain();

    const tab = s.tabAt(PROOF_PATH);
    expect(buildResultData(tab)?.content).toBe('ok');
    expect(tab.verificationResult?.valid).toBe(true);
    expect(s.statuses()[PROOF_PATH]).not.toBe('error');
  });

  it('keeps the newer content when the retry of a failed change finishes after a newer notification', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: JSON.stringify({ ...VALID_PROOF, content: 'initial' }) });
    // 1 回目の通知は読めずに覚えられ、走査が成功した回のやり直しは古い内容を読んだところで止まる
    const failing = scriptedEntry(PROOF_PATH, ['fail', 'hold']);
    await s.folder.handleExternalFileModified(failing.entry);
    s.folder.handleSyncComplete();
    await untilHeld(failing.holding);

    await s.folder.handleExternalFileModified(scriptedEntry(PROOF_PATH, [NEWER]).entry);
    failing.release(OLDER);
    await vi.waitFor(() => expect(failing.holding()).toBe(false));
    await s.drain();

    expect(buildResultData(s.tabAt(PROOF_PATH))?.content).toBe('ok');
    expect(s.tabAt(PROOF_PATH).verificationResult?.valid).toBe(true);
  });

  it('does not count an older load that succeeds after a newer one failed as the change being loaded, and retries the newer change', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: JSON.stringify({ ...VALID_PROOF, content: 'initial' }) });
    const older = scriptedEntry(PROOF_PATH, ['hold']);
    const olderLoad = s.folder.handleExternalFileModified(older.entry);
    await untilHeld(older.holding);
    await s.folder.handleExternalFileModified(scriptedEntry(PROOF_PATH, ['fail', NEWER]).entry);
    expect(s.statusBar.setError).toHaveBeenCalledTimes(1);

    older.release(OLDER);
    await olderLoad;
    // 古い読み込みの結果は捨てる (新しい変更はまだ読めていない)
    expect(s.tabAt(PROOF_PATH).proofData?.content).toBe('initial');

    // 新しい変更は失敗として覚えられたままで、次に走査が成功した回にやり直す
    s.folder.handleSyncComplete();
    await vi.waitFor(() => expect(s.tabAt(PROOF_PATH).proofData?.content).toBe('ok'));
  });

  it('does not remember an older load that fails after a newer one succeeded as a failed change', async () => {
    const s = stack();
    await s.open({ [PROOF_PATH]: JSON.stringify({ ...VALID_PROOF, content: 'initial' }) });
    const older = scriptedEntry(PROOF_PATH, ['hold']);
    const olderLoad = s.folder.handleExternalFileModified(older.entry);
    await untilHeld(older.holding);
    await s.folder.handleExternalFileModified(scriptedEntry(PROOF_PATH, [NEWER]).entry);

    older.release('fail');
    await olderLoad;
    s.folder.handleSyncComplete();

    expect(s.statusBar.setError).not.toHaveBeenCalled();
    expect(older.holding()).toBe(false);
    expect(s.tabAt(PROOF_PATH).proofData?.content).toBe('ok');
  });

  it('loads the newer content into a single tab when a file is modified while it is still being added', async () => {
    const s = stack();
    const path = 'added_proof.json';
    const older = scriptedEntry(path, ['hold']);

    const olderLoad = s.folder.handleExternalFileAdded(older.entry);
    await untilHeld(older.holding);
    await s.folder.handleExternalFileModified(scriptedEntry(path, [NEWER]).entry);
    older.release(OLDER);
    await olderLoad;
    await s.drain();

    expect(document.querySelectorAll(`#file-list .file-item[data-filename="${path}"]`)).toHaveLength(1);
    expect(buildResultData(s.tabAt(path))?.content).toBe('ok');
    expect(s.tabAt(path).verificationResult?.valid).toBe(true);
  });
});

/**
 * 監視中のフォルダが一時的に読めなくなった (#699)。読めない回を削除と取り違えて、読み込み済みのタブ・
 * 検証結果を一覧から外してはいけない。失敗はステータスバーで分かるようにし、3 秒ごとの監視で同じ失敗が
 * 続いても出し直さない (setError は検証集約の表示を上書きする)。復旧したら通常の表示に戻す。
 */
describe('read failure while watching a folder (#699)', () => {
  /** open() で読み込んだのと同じ中身を返すフォルダのハンドル。`unreadable` の間 values() が投げる。 */
  function watchedRoot(entries: Record<string, string>) {
    const control = { unreadable: false };
    const handle = {
      kind: 'directory',
      name: 'folder',
      async *values() {
        if (control.unreadable) throw new DOMException('permission temporarily denied', 'NotAllowedError');
        for (const [path, content] of Object.entries(entries)) {
          yield { kind: 'file', name: path, getFile: async () => ({ lastModified: 1, text: async () => content }) };
        }
      },
    } as unknown as FileSystemDirectoryHandle;
    return { handle, control };
  }

  it('keeps the loaded files and verification results and shows the sync failure once while the folder stays unreadable', async () => {
    const s = stack();
    const entries = { [PROOF_PATH]: VALID, 'valid.js': 'ok' };
    await s.open(entries);
    await s.drain();
    const root = watchedRoot(entries);
    await s.folder.syncManager.startWatching(root.handle, 60 * 60 * 1000);
    const loaded = s.statuses();
    const result = s.tabAt(PROOF_PATH).verificationResult;
    expect(result?.valid).toBe(true);

    root.control.unreadable = true;
    await s.folder.syncManager.forceSync();
    await s.folder.syncManager.forceSync();

    expect(s.onFileRemove).not.toHaveBeenCalled();
    expect(s.sidebar.getFileCount()).toBe(2);
    expect(s.statuses()).toEqual(loaded);
    expect(s.tabAt(PROOF_PATH).verificationResult).toBe(result);
    expect(s.statusBar.setError).toHaveBeenCalledTimes(1);
    expect(s.statusBar.setError.mock.calls[0]![0]).toContain(t('errors.folderSyncFailed'));
    expect(s.onStatusBarUpdate).not.toHaveBeenCalled();

    s.folder.syncManager.stopWatching();
  });

  it('restores the regular status bar once the folder can be read again', async () => {
    const s = stack();
    const entries = { [PROOF_PATH]: VALID };
    await s.open(entries);
    const root = watchedRoot(entries);
    await s.folder.syncManager.startWatching(root.handle, 60 * 60 * 1000);

    root.control.unreadable = true;
    await s.folder.syncManager.forceSync();
    root.control.unreadable = false;
    await s.folder.syncManager.forceSync();
    await s.folder.syncManager.forceSync();

    expect(s.onStatusBarUpdate).toHaveBeenCalledTimes(1);
    expect(s.onFileRemove).not.toHaveBeenCalled();

    s.folder.syncManager.stopWatching();
  });
});
