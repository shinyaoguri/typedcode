/**
 * 現在のタブの export の、ダウンロード後の自己検証のテスト (#565 / #586)。
 *
 * 自己検証は、ZIP に入れたのと同じ proof.json の文字列に検証器 `verifyProofFile` を `{ mode: 'fast' }` で
 * かけた `valid` で「検証: OK」/「警告」を出す (#586)。verify-cli の結論も `verifyProof`
 * (packages/verify-cli/src/verify.ts) が同じ `verifyProofFile` の `valid` を元にするので、ここでは
 * downloadBlob が受けた ZIP を開き、その proof.json に `verifyProofFile(fast)` (モックしない実体) を
 * かけた `valid` を verify-cli の結論の代わりにして、自己検証の通知と突き合わせる。
 *
 * 自己検証は export の区間 (`isExporting`) の外で行い、その間に押した次の export を無視しない (#565)。
 * 検証するのは ZIP と同じスナップショットなので、検証中に同じ proof へ追記されても結論は変わらない。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { TypingProof, computeHash, verifyProofFile } from '@typedcode/shared';
import type { FingerprintComponents, FullVerificationResult, ProofFile } from '@typedcode/shared';
import type { PersistOutcome, TabManager, TabState } from '../../ui/tabs/TabManager.js';

// 自己検証の呼び出しを保留・失敗させられるよう、verifyProofFile だけを差し替え可能にする (既定は実体)。
vi.mock('@typedcode/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typedcode/shared')>();
  return { ...actual, verifyProofFile: vi.fn(actual.verifyProofFile) };
});

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
/** 突き合わせの相手 (verify-cli の結論の代わり)。モックを通さない実体 */
const { verifyProofFile: realVerifyProofFile } =
  await vi.importActual<typeof import('@typedcode/shared')>('@typedcode/shared');
const verifyProofFileMock = vi.mocked(verifyProofFile);

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

/**
 * PoSW Web Worker のスタブ (ProofExporter.drainConsistency.test.ts と同じ流儀)。反復数だけ合わせた偽の
 * PoSW を返す。自己検証は fast (PoSW を再計算しない) なので、この proof は検証器に通る
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
  const downloads: Array<{ filename: string; blob: Blob }> = [];
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
  (exporter as unknown as { downloadBlob: (blob: Blob, filename: string) => void }).downloadBlob = (blob, filename) => {
    downloads.push({ filename, blob });
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

/** ダウンロードされた ZIP から `*_proof.json` を取り出す (ZIP に入ったとおりの文字列を parse する)。 */
async function proofInZip(blob: Blob): Promise<ProofFile> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files).filter((name) => name.endsWith('_proof.json'));
  expect(names).toHaveLength(1);
  return JSON.parse(await zip.file(names[0]!)!.async('string')) as ProofFile;
}

/** verify-cli の結論の代わり: ZIP の proof.json に実体の verifyProofFile を fast でかけた valid */
async function verdictOfZip(blob: Blob): Promise<boolean> {
  return (await realVerifyProofFile(await proofInZip(blob), undefined, { mode: 'fast' })).valid;
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

beforeEach(() => {
  verifyProofFileMock.mockReset();
  verifyProofFileMock.mockImplementation(realVerifyProofFile);
  vi.stubGlobal('Worker', MockPoswWorker);
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('window', { location: { hostname: 'unit-test.local' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ProofExporter.exportCurrentTab verification after download (#565 / #586)', () => {
  it('notifies successVerified for an untouched proof, matching the verifier run on the proof.json in the ZIP', async () => {
    const tab = await makeTab('abc');
    const { exporter, notifications, downloads } = createExporter(tab);

    await exporter.exportCurrentTab();

    expect(downloads).toHaveLength(1);
    expect(await verdictOfZip(downloads[0]!.blob)).toBe(true);
    expect(notifications).toEqual(['export.successVerified']);
  });

  it('starts a second export while the first export is still verifying its proof after the download', async () => {
    const tab = await makeTab('abc');
    const firstVerification = deferred<FullVerificationResult>();
    verifyProofFileMock.mockReturnValueOnce(firstVerification.promise);
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
    firstVerification.resolve({ valid: true } as FullVerificationResult);
    await first;
  });

  it('reports a verification that throws after the download as a verification failure, not as a failed export', async () => {
    const tab = await makeTab('abc');
    verifyProofFileMock.mockRejectedValue(new Error('verifier crashed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exporter, notifications, downloads } = createExporter(tab);

    await exporter.exportCurrentTab();

    expect(downloads).toHaveLength(1);
    expect(notifications).toEqual(['export.verifyFailed']);
  });

  it('verifies the proof.json snapshot in the ZIP even when the same proof is appended to at the download', async () => {
    const tab = await makeTab('abcdefghij');
    const { exporter, notifications, downloads, whenDownloaded } = createExporter(tab);
    let eventsAtDownload = -1;
    let appended: Promise<void> | null = null;
    whenDownloaded(() => {
      whenDownloaded(() => {});
      eventsAtDownload = tab.typingProof.events.length;
      // 自己検証の前に、同じ proof へ記録が載る (2 回目の export の reflectionNote / attestation と同じ形)
      appended = typeInto(tab.typingProof, 'k', 10);
    });

    await exporter.exportCurrentTab();
    await appended;

    // 記録が実際に載ったこと (載らなければこのテストは何も確かめていない)
    expect(tab.typingProof.events.length).toBeGreaterThan(eventsAtDownload);
    const verified = verifyProofFileMock.mock.calls[0]![0];
    expect(verified.proof.events).toHaveLength(eventsAtDownload);
    expect(verified).toEqual(await proofInZip(downloads[0]!.blob));
    expect(notifications).toEqual(['export.successVerified']);
  });

  it('agrees with the verifier on the ZIP when only a field outside the hash is rewritten in memory', async () => {
    const tab = await makeTab('abc');
    // description はハッシュに入らない (`pickHashedEventFields` の外) ので、書き換えても検証は通る
    (tab.typingProof.events[1] as { description?: string }).description = 'rewritten outside the hash';
    const { exporter, notifications, downloads } = createExporter(tab);

    await exporter.exportCurrentTab();

    const inZip = await proofInZip(downloads[0]!.blob);
    // 書き換えが ZIP まで届いたこと (届かなければこのテストは何も確かめていない)
    expect((inZip.proof.events[1] as { description?: string }).description).toBe('rewritten outside the hash');
    expect(await verdictOfZip(downloads[0]!.blob)).toBe(true);
    expect(notifications).toEqual(['export.successVerified']);
  });

  it('agrees with the verifier on the ZIP when the chain root no longer matches the recorded nonce', async () => {
    const tab = await makeTab('abc');
    // root (initialEventChainHash = SHA-256(fingerprintHash ‖ nonce)) と食い違う nonce に書き換える。
    // events のチェーンそのものは無傷なので、チェーンだけを見る検証では OK になる
    tab.typingProof.initialHashNonce = 'f'.repeat(64);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exporter, notifications, downloads } = createExporter(tab);

    await exporter.exportCurrentTab();

    expect(await verdictOfZip(downloads[0]!.blob)).toBe(false);
    expect(notifications).toEqual(['export.verifyFailed']);
  });
});
