/**
 * 書き出す ZIP への問題文の同梱 (#778)。
 *
 * 授業・課題では、問題を読み込んだタブの問題文 (配布ファイルの `statement`) を `<base>_problem.md` として
 * proof の隣に入れる。入れるかどうかは main が注入する resolver で決まり (casual / exam は注入しない)、
 * 名前の番号は proof と揃える (shared の `createExportNamer`)。問題文は証明の対象外の平文で、
 * proof JSON とハッシュチェーンには入れない (ADR-0014 の「証明に項目を足さない」)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { FingerprintComponents } from '@typedcode/shared';
import type { PersistOutcome, TabManager, TabState } from '../../ui/tabs/TabManager.js';

vi.mock('../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => false,
  loadTurnstileScript: async (): Promise<void> => {},
  performTurnstileVerification: async () => ({ success: true, attestation: null }),
}));

vi.mock('../../ui/components/ExportProgressDialog.js', () => ({
  ExportProgressDialog: class {
    show(): void {}
    hide(): void {}
    updatePhase(): void {}
    updateProgress(): void {}
    showDrainProgress(): void {}
    getTurnstileContainer(): HTMLElement | null {
      return null;
    }
  },
}));

const { ProofExporter } = await import('../ProofExporter.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (ProblemStatement Test)',
  language: 'en',
  languages: ['en'],
  platform: 'TestOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 860,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

/** `content` を 1 文字ずつ打ったタブを作る (proof が valid になるよう、チェーンとバッファを一致させる)。 */
async function makeTab(filename: string, language: string, content: string): Promise<TabState> {
  const typingProof = new TypingProof();
  await typingProof.initialize(await computeHash(JSON.stringify(components, null, 0)), components);
  let typed = '';
  for (const ch of content) {
    await typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: typed.length,
      rangeLength: 0,
    });
    typed += ch;
  }
  return {
    id: `tab-${filename}`,
    filename,
    language,
    typingProof,
    model: { getValue: () => content } as unknown as TabState['model'],
    createdAt: Date.now(),
    verificationState: 'unverified',
  } as unknown as TabState;
}

const SAVED: PersistOutcome = { idbOk: true, sessionStorageOk: true };

/** タブを書き出して、ダウンロードした ZIP を返す。`statements` を渡したときだけ resolver を注入する。 */
async function exportZip(tabs: TabState[], statements?: Record<string, string>): Promise<JSZip> {
  const exporter = new ProofExporter();
  const blobs: Blob[] = [];
  exporter.setTabManager({
    getAllTabs: () => tabs,
    getActiveTab: () => tabs[0] ?? null,
    getActiveProof: () => tabs[0]?.typingProof ?? null,
    getTabSwitches: () => [],
    flushToIndexedDB: async () => SAVED,
  } as unknown as TabManager);
  if (statements) {
    exporter.setProblemStatementResolver((tab) => statements[tab.id] ?? null);
  }
  (exporter as unknown as { downloadBlob: (blob: Blob) => void }).downloadBlob = (blob) => {
    blobs.push(blob);
  };
  await exporter.exportAllTabsAsZip();
  expect(blobs).toHaveLength(1);
  return JSZip.loadAsync(await blobs[0]!.arrayBuffer());
}

function problemEntries(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((name) => name.includes('_problem'))
    .sort();
}

/** PoSW Web Worker のスタブ (node 環境には Worker が無い)。PoSW の値はこのテストの関心ではない。 */
class MockPoswWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage || message.type !== 'compute-posw') return;
      this.onmessage({
        data: {
          type: 'posw-result',
          requestId: message.requestId,
          iterations: message.iterations,
          nonce: 'mock-nonce',
          intermediateHash: 'mock-intermediate-hash',
          computeTimeMs: 1,
        },
      } as MessageEvent);
    });
  }

  terminate(): void {}
}

beforeEach(() => {
  vi.stubGlobal('Worker', MockPoswWorker);
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('window', { location: { hostname: 'unit-test.local' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProofExporter problem statements in the ZIP (#778)', () => {
  it('bundles <base>_problem.md only for the tabs the resolver returns a statement for', async () => {
    const tabs = [await makeTab('p1.c', 'c', 'a'), await makeTab('p2.c', 'c', 'b'), await makeTab('extra.c', 'c', 'c')];

    const zip = await exportZip(tabs, { 'tab-p1.c': '# P1', 'tab-p2.c': '# P2' });

    expect(problemEntries(zip)).toEqual(['p1_problem.md', 'p2_problem.md']);
  });

  it('writes the statement exactly as given, as UTF-8 bytes', async () => {
    const statement = '# 問題1\r\n和を出力せよ。  \n\u{1F600}\n';
    const tabs = [await makeTab('p1.c', 'c', 'a')];

    const zip = await exportZip(tabs, { 'tab-p1.c': statement });

    const bytes = await zip.file('p1_problem.md')!.async('uint8array');
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(statement)));
  });

  it('numbers the problem statement like the proof when two tabs share a base name (main.c + main.py)', async () => {
    const tabs = [await makeTab('main.c', 'c', 'a'), await makeTab('main.py', 'python', 'b')];

    const zip = await exportZip(tabs, { 'tab-main.c': 'C problem', 'tab-main.py': 'Python problem' });

    expect(await zip.file('main_problem.md')!.async('string')).toBe('C problem');
    expect(await zip.file('main_problem_1.md')!.async('string')).toBe('Python problem');
  });

  it('bundles no problem statement when no resolver is set (casual / exam)', async () => {
    const tabs = [await makeTab('p1.c', 'c', 'a')];

    const zip = await exportZip(tabs);

    expect(problemEntries(zip)).toEqual([]);
  });

  it('keeps the statement out of every proof.json', async () => {
    const statement = 'UNIQUE-STATEMENT-778';
    const tabs = [await makeTab('p1.c', 'c', 'a'), await makeTab('p2.c', 'c', 'b')];

    const zip = await exportZip(tabs, { 'tab-p1.c': statement, 'tab-p2.c': statement });

    const proofNames = Object.keys(zip.files).filter((name) => name.endsWith('_proof.json'));
    expect(proofNames).toHaveLength(2);
    for (const name of proofNames) {
      expect(await zip.file(name)!.async('string')).not.toContain(statement);
    }
  });

  it('lists the bundled problem statements in both READMEs', async () => {
    const tabs = [await makeTab('p1.c', 'c', 'a')];

    const zip = await exportZip(tabs, { 'tab-p1.c': '# P1' });

    expect(await zip.file('README.md')!.async('string')).toContain('`p1_problem.md`');
    expect(await zip.file('README.ja.md')!.async('string')).toContain('`p1_problem.md`');
  });
});
