/**
 * ProofExporter の「content と chain の一貫性」テスト (#225)。
 *
 * export は `model.getValue()` を content として proof に焼くが、exportProof が同梱する
 * events は記録キュー排出済みのスナップショットしか含まない。直前の打鍵がまだ PoSW キューに
 * 残ったまま export すると「content にはあるが chain には無い」proof になり、
 * content replay (検証 Layer 4) で **proof 全体が invalid** になる。学生に過失が無いまま
 * 答案が検証不能になるので、排出できなかったときは **export を中止**して再試行させる
 * (content を切り詰めると提出物からデータが黙って消えるため採らない)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { TypingProof, computeHash, verifyContentReplay } from '@typedcode/shared';
import type { FingerprintComponents, QueueDrainResult } from '@typedcode/shared';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';

const turnstile = vi.hoisted(() => ({ configured: false }));

vi.mock('../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => turnstile.configured,
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

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (DrainConsistency Test)',
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
});

/** チェーンに `chained` を記録済みで、buffer には `bufferContent` が入っているタブを作る。 */
async function makeTab(id: string, chained: string, bufferContent: string): Promise<TabState> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const typingProof = new TypingProof();
  await typingProof.initialize(fingerprintHash, components);

  let content = '';
  for (const ch of chained) {
    await typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }

  return {
    id,
    filename: `${id}.txt`,
    language: 'plaintext',
    typingProof,
    model: { getValue: () => bufferContent } as unknown as TabState['model'],
    createdAt: Date.now(),
    verificationState: 'unverified',
  } as unknown as TabState;
}

/** 排出しきれない (停滞した) 状態を模す。実キューを止める代わりに待機結果だけ差し替える。 */
function stallQueue(tab: TabState, remaining = 1): void {
  const stalled: QueueDrainResult = { drained: false, remaining, reason: 'stalled', waitedMs: 5000 };
  tab.typingProof.waitForQueueDrain = async () => stalled;
}

interface Download {
  blob: Blob;
  filename: string;
}

function createExporter(tabs: TabState[]) {
  const exporter = new ProofExporter();
  const notifications: string[] = [];
  const downloads: Download[] = [];
  exporter.setCallbacks({ onNotification: (message) => notifications.push(message) });
  exporter.setTabManager({
    getAllTabs: () => tabs,
    getActiveTab: () => tabs[0] ?? null,
    getActiveProof: () => tabs[0]?.typingProof ?? null,
    getTabSwitches: () => [],
    flushToIndexedDB: async () => {},
  } as unknown as TabManager);
  // ダウンロード経路は DOM 依存なので差し替えて blob を捕捉する。
  (exporter as unknown as { downloadBlob: (blob: Blob, filename: string) => void }).downloadBlob = (blob, filename) => {
    downloads.push({ blob, filename });
  };
  return { exporter, notifications, downloads };
}

/** ZIP から proof JSON を取り出す。 */
async function readProof(download: Download): Promise<{ content: string; proof: { events: unknown[] } }> {
  const zip = await JSZip.loadAsync(await download.blob.arrayBuffer());
  const name = Object.keys(zip.files).find((f) => f.endsWith('_proof.json'));
  const json = await zip.file(name!)!.async('string');
  return JSON.parse(json);
}

/**
 * PoSW Web Worker のスタブ (node 環境には Worker が無い)。
 * PoSW 値そのものはこのテストの関心ではない (関心は content と chain の一貫性) ので、
 * shared のテスト setup と同じくダミー値を返して計算コストを避ける。
 */
class MockPoswWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage) return;
      const data =
        message.type === 'compute-posw'
          ? {
              type: 'posw-result',
              requestId: message.requestId,
              iterations: message.iterations,
              nonce: 'mock-nonce',
              intermediateHash: 'mock-intermediate-hash',
              computeTimeMs: 1,
            }
          : { type: 'verify-result', requestId: message.requestId, valid: true };
      this.onmessage({ data } as MessageEvent);
    });
  }

  terminate(): void {}
}

beforeEach(() => {
  turnstile.configured = false;
  vi.stubGlobal('Worker', MockPoswWorker);
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('window', { location: { hostname: 'unit-test.local' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProofExporter.exportCurrentTab drain consistency (#225)', () => {
  it('aborts the export when the record queue could not be drained', async () => {
    const tab = await makeTab('tab-1', 'ab', 'abc');
    stallQueue(tab);
    const { exporter, downloads, notifications } = createExporter([tab]);

    await exporter.exportCurrentTab();

    expect(downloads).toHaveLength(0);
    expect(notifications).toEqual([expect.any(String)]);
  });

  it('does not build a proof from buffer content that is not on the chain', async () => {
    const tab = await makeTab('tab-1', 'ab', 'abc');
    stallQueue(tab);
    const exportProof = vi.spyOn(tab.typingProof, 'exportProof');
    const { exporter } = createExporter([tab]);

    await exporter.exportCurrentTab();

    expect(exportProof).not.toHaveBeenCalled();
  });

  it('exports a proof whose content replays from the chain when the queue drains', async () => {
    const tab = await makeTab('tab-1', 'abc', 'abc');
    const { exporter, downloads } = createExporter([tab]);

    await exporter.exportCurrentTab();

    expect(downloads).toHaveLength(1);
    const exported = await readProof(downloads[0]!);
    expect(verifyContentReplay(exported.proof.events as never, exported.content)).toMatchObject({ valid: true });
  });
});

describe('ProofExporter.exportAllTabsAsZip drain consistency (#225)', () => {
  it('aborts the whole export when any tab could not drain its record queue', async () => {
    const first = await makeTab('tab-1', 'abc', 'abc');
    const second = await makeTab('tab-2', 'ab', 'abc');
    stallQueue(second);
    const { exporter, downloads, notifications } = createExporter([first, second]);

    await exporter.exportAllTabsAsZip();

    expect(downloads).toHaveLength(0);
    expect(notifications).toEqual([expect.any(String)]);
  });

  it('exports every tab when all record queues drain', async () => {
    const first = await makeTab('tab-1', 'ab', 'ab');
    const second = await makeTab('tab-2', 'cd', 'cd');
    const { exporter, downloads } = createExporter([first, second]);

    await exporter.exportAllTabsAsZip();

    expect(downloads).toHaveLength(1);
  });
});
