// @vitest-environment happy-dom
/**
 * Web の提出物照合 (#293): 同梱ソースと proof.content を shared の `matchSubmissionSources` で突き合わせる。
 *
 * 実物の FileController / FileProcessor / Sidebar / VerifyTabManager / VerificationController に ZIP を読ませ、
 * サイドバーの `data-status` (状態契約) で結論を見る。検証 (Worker) は走らせず、検証完了は健全な結果を
 * `handleComplete` に渡して再現する (整合性は proven のまま、提出物の照合だけが status を変えることを見る)。
 *
 * 対応規則と比較の境界は shared の `submissionSources.test.ts` が持つ。ここは Web の配線を固定する:
 * 不一致 = error、欠落 / 孤立 = warning、editor の実出力 2 形は全件 success、
 * 不一致・proof 破損・proof なしでも同梱ソースは平文タブとして開ける。
 */

import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProcessor } from '../../services/FileProcessor.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import type { VerificationResultData } from '../../types.js';
import { FileController } from '../controllers/FileController.js';
import {
  VerificationController,
  type VerificationControllerDependencies,
} from '../controllers/VerificationController.js';
import { Sidebar } from '../Sidebar.js';
import { TabBar } from '../TabBar.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const CONTENT = 'int main() { return 0; }\n';

/** チェーン (events) の中身は照合に関係しないので空でよい。`isProofFile` を満たす最小の proof。 */
function proofJson(filename: string, language: string, content: string): string {
  return JSON.stringify({ proof: { events: [] }, typingProofHash: 'h', filename, language, content });
}

function healthy(): VerificationResultData {
  return {
    valid: true,
    metadataValid: true,
    chainValid: true,
    isPureTyping: true,
    rootAnchored: true,
    signedCheckpointAnchored: true,
    signedCheckpointValid: true,
  };
}

async function zipFile(entries: Record<string, string | Uint8Array>): Promise<File> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'export.zip');
}

function stack() {
  const tabManager = new VerifyTabManager();
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
  const uiState = new UIStateManager();
  const enqueued: string[] = [];

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
  const files = new FileController({
    fileProcessor: new FileProcessor(),
    tabManager,
    uiState,
    verificationQueue: { enqueue: (item: { id: string }) => enqueued.push(item.id) },
    sidebar,
    statusBar: { setError: vi.fn() },
    generateId: () => `t${++n}`,
    tabBar,
    onSubmissionChange: (id: string) => verification.recomputeStatus(id),
  } as unknown as ConstructorParameters<typeof FileController>[0]);

  /** ZIP を読み込み、検証が全 proof について健全に終わったことにする。 */
  async function load(entries: Record<string, string | Uint8Array>): Promise<void> {
    await files.processFile(await zipFile(entries));
    for (const id of enqueued.splice(0)) verification.handleComplete(id, healthy());
  }

  /** `data-filename` (表示名) → サイドバーの status。 */
  function statuses(): Record<string, string | undefined> {
    return Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('#file-list .file-item')].map((el) => [
        el.dataset.filename ?? '',
        el.dataset.status,
      ])
    );
  }

  sidebar.addFolder({ id: 'folder', name: 'folder', expanded: true });

  return { files, tabManager, verification, load, statuses, enqueued };
}

beforeEach(() => {
  mountVerifyIndexHtml();
});

describe('Web submission check (#293)', () => {
  it('marks both the proof and the bundled source as error when the source differs from proof.content', async () => {
    const { load, statuses } = stack();

    await load({
      'valid_proof.json': proofJson('valid.js', 'javascript', 'x'),
      'valid.js': 'THIS IS NOT THE VERIFIED CONTENT',
    });

    expect(statuses()).toMatchObject({ 'valid_proof.json': 'error', 'valid.js': 'error' });
  });

  it('reports the failure as a submission issue on the proof without touching its verification result', async () => {
    const { load, tabManager } = stack();

    await load({
      'valid_proof.json': proofJson('valid.js', 'javascript', 'x'),
      'valid.js': 'THIS IS NOT THE VERIFIED CONTENT',
    });

    const proofTab = tabManager.getAllTabs().find((t) => t.filename === 'valid_proof.json')!;
    expect(proofTab.associatedSourceMismatch).toMatchObject({
      kind: 'mismatch',
      severity: 'error',
      filename: 'valid.js',
    });
    // 整合性は proven のまま: 検証結果は健全なまま保たれ、落ちるのは提出物の状態 (status) だけ
    expect(proofTab.verificationResult?.valid).toBe(true);
    expect(proofTab.verificationResult?.chainValid).toBe(true);
  });

  it('keeps the original bundled source readable as a plaintext tab even when it mismatches', async () => {
    const { load, tabManager } = stack();

    await load({
      'valid_proof.json': proofJson('valid.js', 'javascript', 'x'),
      'valid.js': 'THIS IS NOT THE VERIFIED CONTENT',
    });

    const source = tabManager.getAllTabs().find((t) => t.filename === 'valid.js')!;
    expect(source.isPlaintext).toBe(true);
    expect(source.plaintextContent).toBe('THIS IS NOT THE VERIFIED CONTENT');
  });

  it('treats a BOM-only difference as a mismatch', async () => {
    const { load, statuses } = stack();

    await load({
      'valid_proof.json': proofJson('valid.js', 'javascript', 'x'),
      'valid.js': new Uint8Array([0xef, 0xbb, 0xbf, 0x78]),
    });

    expect(statuses()['valid_proof.json']).toBe('error');
  });

  it('matches the editor output of same-name tabs (main.c x 2), including the second tab', async () => {
    const { load, statuses } = stack();

    await load({
      'main_proof.json': proofJson('main.c', 'c', CONTENT),
      'main_proof_1.json': proofJson('main.c', 'c', CONTENT),
      'main.c': CONTENT,
      'main_1.c': CONTENT,
    });

    expect(statuses()).toEqual({
      'main_proof.json': 'success',
      'main_proof_1.json': 'success',
      'main.c': 'success',
      'main_1.c': 'success',
    });
  });

  it('matches the editor output of tabs that differ only by extension (main.c + main.py)', async () => {
    const { load, statuses } = stack();

    await load({
      'main_proof.json': proofJson('main.c', 'c', CONTENT),
      'main_proof_1.json': proofJson('main.py', 'python', 'print(1)'),
      'main.c': CONTENT,
      'main.py': 'print(1)',
    });

    expect(Object.values(statuses())).toEqual(['success', 'success', 'success', 'success']);
  });

  it('warns about a missing source and about an orphan source, neither as error', async () => {
    const { load, statuses } = stack();

    await load({
      'a_proof.json': proofJson('a.c', 'c', CONTENT),
      'extra.py': 'print(1)',
    });

    expect(statuses()).toMatchObject({ 'a_proof.json': 'warning', 'extra.py': 'warning' });
  });

  it('opens the bundled sources as plaintext tabs when a proof is broken', async () => {
    const { load, tabManager, statuses } = stack();

    await load({ 'a_proof.json': '{"proof":', 'a.c': CONTENT });

    expect(statuses()['a_proof.json']).toBe('error');
    expect(tabManager.getAllTabs().find((t) => t.filename === 'a.c')?.plaintextContent).toBe(CONTENT);
  });

  it('opens the bundled sources as plaintext tabs when the ZIP has no proof at all, without a verdict', async () => {
    const { load, tabManager, statuses } = stack();

    await load({ 'a.c': CONTENT, 'notes.txt': 'memo' });

    expect(statuses()).toEqual({ 'a.c': 'success', 'notes.txt': 'success' });
    expect(tabManager.getAllTabs().map((t) => t.plaintextContent)).toEqual([CONTENT, 'memo']);
  });

  it('applies the result to a proof whose verification finished before the sources were read', async () => {
    const { files, verification, tabManager, statuses } = stack();
    // フォルダ読み込み (FSA) のように、proof が先に検証を終えてから、ソースが後から足される
    files.addFileToVerification('a_proof.json', proofJson('a.c', 'c', CONTENT), 'folder');
    const proofId = tabManager.getAllTabs()[0]!.id;
    verification.handleComplete(proofId, healthy());
    expect(statuses()['a_proof.json']).toBe('success');

    files.addPlaintextFile({ filename: 'a.c', type: 'plaintext', language: 'c', rawData: 'tampered' }, 'folder');
    files.settleSubmission();

    expect(statuses()).toMatchObject({ 'a_proof.json': 'error', 'a.c': 'error' });
  });

  it('re-evaluates the proof as missing-source (warning) when the offending source is removed', async () => {
    const { files, verification, tabManager, statuses } = stack();
    files.addFileToVerification('a_proof.json', proofJson('a.c', 'c', CONTENT), 'folder');
    verification.handleComplete(tabManager.getAllTabs()[0]!.id, healthy());
    files.addPlaintextFile({ filename: 'a.c', type: 'plaintext', language: 'c', rawData: 'tampered' }, 'folder');
    files.settleSubmission();
    const sourceId = tabManager.getAllTabs().find((t) => t.filename === 'a.c')!.id;

    files.forgetSubmissionFiles([sourceId]);

    // ソースが無くなったので、不一致 (error) ではなく欠落 (warning) になる
    expect(statuses()['a_proof.json']).toBe('warning');
  });
});
