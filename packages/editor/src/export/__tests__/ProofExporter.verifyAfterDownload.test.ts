/**
 * 現在のタブの export の、ダウンロード後の自己検証のテスト (#565)。
 *
 * export はダウンロードで終わり、その後の `typingProof.verify()` (全イベントの PoSW の再計算。件数が多いと
 * 数十秒) は結果を通知するための自己検証にすぎない。これを export の区間 (`isExporting`) の中で待つと、
 * その間に押した次の export が何も出さずに無視される。検証は区間の外で行い、通知は従来どおり出す。
 * 検証の途中で次の export が同じ proof に記録しても、検証が壊れないことも固定する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { FingerprintComponents, VerificationResult } from '@typedcode/shared';
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

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { ProofExporter } = await import('../ProofExporter.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (VerifyAfterDownload Test)',
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

/** PoSW Web Worker のスタブ (ProofExporter.drainConsistency.test.ts と同じ流儀)。検証は常に通す */
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

async function typeInto(typingProof: TypingProof, text: string, offset = 0): Promise<void> {
  let at = offset;
  for (const ch of text) {
    await typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: at,
      rangeLength: 0,
    });
    at += 1;
  }
}

/** チェーンに `content` を打鍵として記録済みのタブを作る。 */
async function makeTab(content: string): Promise<TabState> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const typingProof = new TypingProof();
  await typingProof.initialize(fingerprintHash, components);
  await typeInto(typingProof, content);
  return {
    id: 'tab-1',
    filename: 'tab-1.txt',
    language: 'plaintext',
    typingProof,
    model: { getValue: () => content } as unknown as TabState['model'],
    createdAt: Date.now(),
    verificationState: 'unverified',
  } as unknown as TabState;
}

const SAVED: PersistOutcome = { idbOk: true, sessionStorageOk: true };

function createExporter(tab: TabState) {
  const exporter = new ProofExporter();
  const notifications: string[] = [];
  const downloads: string[] = [];
  let onDownload: (() => void) | null = null;
  exporter.setCallbacks({ onNotification: (message) => notifications.push(message) });
  exporter.setTabManager({
    getAllTabs: () => [tab],
    getActiveTab: () => tab,
    getActiveProof: () => tab.typingProof,
    getTabSwitches: () => [],
    flushToIndexedDB: async () => SAVED,
  } as unknown as TabManager);
  // ダウンロード経路は DOM 依存なので差し替える。ダウンロードの瞬間に割り込む手を `onDownload` で差せる。
  (exporter as unknown as { downloadBlob: (blob: Blob, filename: string) => void }).downloadBlob = (
    _blob,
    filename
  ) => {
    downloads.push(filename);
    onDownload?.();
  };
  return {
    exporter,
    notifications,
    downloads,
    whenDownloaded: (fn: () => void) => {
      onDownload = fn;
    },
  };
}

/** 解決を外から決める promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const VALID: VerificationResult = { valid: true, message: 'ok' };

beforeEach(() => {
  vi.stubGlobal('Worker', MockPoswWorker);
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('window', { location: { hostname: 'unit-test.local' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ProofExporter.exportCurrentTab verification after download (#565)', () => {
  it('starts a second export while the first export is still verifying the chain after its download', async () => {
    const tab = await makeTab('abc');
    const firstVerification = deferred<VerificationResult>();
    vi.spyOn(tab.typingProof, 'verify').mockReturnValueOnce(firstVerification.promise).mockResolvedValue(VALID);
    const { exporter, downloads, whenDownloaded } = createExporter(tab);
    let second: Promise<void> | null = null;
    whenDownloaded(() => {
      whenDownloaded(() => {});
      // 利用者の次のクリックと同じく、ダウンロードの同期区間を抜けてから押す
      queueMicrotask(() => {
        second = exporter.exportCurrentTab();
      });
    });

    const first = exporter.exportCurrentTab();
    await vi.waitFor(() => expect(second).not.toBeNull());
    await second;

    expect(downloads).toHaveLength(2);
    firstVerification.resolve(VALID);
    await first;
  });

  it('notifies verifyFailed when the chain verified after the download is invalid', async () => {
    const tab = await makeTab('abc');
    vi.spyOn(tab.typingProof, 'verify').mockResolvedValue({ valid: false, message: 'broken' });
    const { exporter, notifications } = createExporter(tab);

    await exporter.exportCurrentTab();

    expect(notifications).toEqual(['export.verifyFailed']);
  });

  it('reports a verification that throws after the download as a verification failure, not as a failed export', async () => {
    const tab = await makeTab('abc');
    vi.spyOn(tab.typingProof, 'verify').mockRejectedValue(new Error('worker crashed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exporter, notifications, downloads } = createExporter(tab);

    await exporter.exportCurrentTab();

    expect(downloads).toHaveLength(1);
    expect(notifications).toEqual(['export.verifyFailed']);
  });

  it('keeps the first verification valid when a second export records on the same proof while it runs', async () => {
    const tab = await makeTab('abcdefghij');
    const lengths: Array<{ atStart: number; atEnd: number; valid: boolean }> = [];
    const realVerify = tab.typingProof.verify.bind(tab.typingProof);
    vi.spyOn(tab.typingProof, 'verify').mockImplementation(async (...args) => {
      const atStart = tab.typingProof.events.length;
      const result = await realVerify(...args);
      lengths.push({ atStart, atEnd: tab.typingProof.events.length, valid: result.valid });
      return result;
    });
    const { exporter, notifications, whenDownloaded } = createExporter(tab);
    let appended: Promise<void> | null = null;
    whenDownloaded(() => {
      whenDownloaded(() => {});
      // 1 回目の検証の最中に、同じ proof へ記録が載る (2 回目の export の reflectionNote / attestation と同じ形)
      appended = typeInto(tab.typingProof, 'k', 10);
    });

    await exporter.exportCurrentTab();
    await appended;

    // 記録が検証の途中に載ったこと (載らなければこのテストは何も確かめていない)
    expect(lengths[0]!.atEnd).toBeGreaterThan(lengths[0]!.atStart);
    expect(lengths[0]!.valid).toBe(true);
    expect(notifications).toEqual(['export.successVerified']);
  });
});
