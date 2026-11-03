// @vitest-environment happy-dom
/**
 * 提出物 (同梱ソースと proof.content) の照合の web ↔ CLI パリティ (#293)
 *
 * 同じ ZIP を verify-cli (実プロセス) と verify (web の FileController) に通し、**結論が一致する**ことを固定する。
 * CLI は exit code、web は各ファイルの `data-status`。どちらも shared の `matchSubmissionSources` /
 * `submissionSeverity` を通るので、片方だけが別の規則 (名前の推測など) に戻ると、ここで割れる。
 *
 * 材料: CLI 側は実 PoSW 付きの有効 proof (`valid.json`: filename `valid` / language `javascript` /
 * content `ok`) を使うので、期待ソース名は `valid.js`。web 側は検証を走らせず、同じ proof JSON を
 * 取り込んで健全な検証結果を返したことにする (照合以外で status が動かない)。
 *
 * 他の web ↔ CLI パリティ (検証・三層保証・スクショ) は `webCliParity.test.ts`。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProcessor } from '../FileProcessor.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import type { VerificationResultData } from '../../types.js';
import { FileController } from '../../ui/controllers/FileController.js';
import {
  VerificationController,
  type VerificationControllerDependencies,
} from '../../ui/controllers/VerificationController.js';
import { Sidebar } from '../../ui/Sidebar.js';
import { TabBar } from '../../ui/TabBar.js';
import { mountVerifyIndexHtml } from '../../ui/__tests__/verifyDom.js';

// happy-dom 環境では import.meta.url が file: にならないので、runCli ヘルパは使わず、パッケージルート (= cwd) から引く。
const CLI_ROOT = resolve(process.cwd(), '../verify-cli');
const TSX_CLI = createRequire(join(process.cwd(), 'package.json')).resolve('tsx/cli');
const VALID = readFileSync(join(CLI_ROOT, 'src/__tests__/fixtures/proofs/valid.json'), 'utf-8');
const CONTENT = 'ok';

function proofFor(filename: string, language: string): string {
  return JSON.stringify({ ...JSON.parse(VALID), filename, language });
}

const healthy: VerificationResultData = {
  valid: true,
  metadataValid: true,
  chainValid: true,
  isPureTyping: true,
  rootAnchored: true,
  signedCheckpointAnchored: true,
  signedCheckpointValid: true,
};

type Entries = Record<string, string | Uint8Array>;

async function zipBytes(entries: Entries): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

function cliExitCode(bytes: Uint8Array): number | null {
  const path = join(mkdtempSync(join(tmpdir(), 'tc-parity-submission-')), 'export.zip');
  writeFileSync(path, bytes);
  return spawnSync(process.execPath, [TSX_CLI, join(CLI_ROOT, 'src/cli.ts'), path, '--mode', 'full'], {
    cwd: CLI_ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
  }).status;
}

/** web に ZIP を読ませ、全 proof の検証が健全に終わったことにして、proof 行のどれかが error か返す。 */
async function webHasError(bytes: Uint8Array): Promise<boolean> {
  mountVerifyIndexHtml();
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

  await files.processFile(new File([bytes as BlobPart], 'export.zip'));
  for (const id of enqueued) verification.handleComplete(id, healthy);

  return [...document.querySelectorAll<HTMLElement>('#file-list .file-item')].some(
    (el) => el.dataset.status === 'error'
  );
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('web and CLI reach the same conclusion on the same ZIP (#293)', () => {
  const cases: Array<[string, Entries, 'fail' | 'pass']> = [
    ['a bundled source that differs from proof.content', { 'valid_proof.json': VALID, 'valid.js': 'FAKE' }, 'fail'],
    [
      'the genuine source under another name with a fake at the expected name',
      { 'valid_proof.json': VALID, 'valid.js': 'FAKE', 'valid_1.js': CONTENT },
      'fail',
    ],
    [
      'a source with a UTF-8 BOM',
      { 'valid_proof.json': VALID, 'valid.js': new Uint8Array([0xef, 0xbb, 0xbf, 0x6f, 0x6b]) },
      'fail',
    ],
    ['a source that matches', { 'valid_proof.json': VALID, 'valid.js': CONTENT }, 'pass'],
    [
      'same-name tabs (main.c x 2)',
      {
        'main_proof.json': proofFor('main.c', 'c'),
        'main_proof_1.json': proofFor('main.c', 'c'),
        'main.c': CONTENT,
        'main_1.c': CONTENT,
      },
      'pass',
    ],
    [
      'tabs that differ only by extension (main.c + main.py)',
      {
        'main_proof.json': proofFor('main.c', 'c'),
        'main_proof_1.json': proofFor('main.py', 'python'),
        'main.c': CONTENT,
        'main.py': CONTENT,
      },
      'pass',
    ],
    ['a missing source (warning only)', { 'valid_proof.json': VALID }, 'pass'],
    ['an orphan source (warning only)', { 'valid_proof.json': VALID, 'valid.js': CONTENT, 'extra.py': 'x' }, 'pass'],
  ];

  it.each(cases)('agrees on %s', async (_label, entries, expected) => {
    const bytes = await zipBytes(entries);

    const cliFailed = cliExitCode(bytes) !== 0;
    const webFailed = await webHasError(bytes);

    expect(cliFailed).toBe(expected === 'fail');
    expect(webFailed).toBe(cliFailed);
  });
});
