/**
 * コード実行の start / result が、実行を始めたタブの proof に記録されることの検査 (#698)。
 *
 * CodeExecutionController → recordToOwnerTab → EventRecorder → TypingProof を本物のまま、
 * main.ts と同じ配線で 2 タブにつなぐ。差し替えるのは言語ランタイム・永続化・TabManager (タブの
 * 出し入れだけを持つスタブ) だけ。実行が終わる前に表示中のタブ (active) が変わっても、記録先は
 * 開始時のタブ ID で決まる。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingProof, computeHash } from '@typedcode/shared';
import type { CodeExecutionEventData, FingerprintComponents } from '@typedcode/shared';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';
import type { LogViewer } from '../../ui/components/LogViewer.js';
import type { ExecutionResult } from '../../executors/interfaces/ILanguageExecutor.js';

const persistence = vi.hoisted(() => ({
  saveEventToIndexedDB: vi.fn(async (_tabId: string, _event: unknown) => {}),
  saveTabsToSessionStorage: vi.fn(),
}));

vi.mock('../../core/EventPersistence.js', () => ({
  EventPersistence: class {
    saveEventToIndexedDB = persistence.saveEventToIndexedDB;
    saveTabsToSessionStorage = persistence.saveTabsToSessionStorage;
  },
}));

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));

/** 偽の executor の run は、テストが手で解決する Promise を返す */
const fake = vi.hoisted(() => ({
  pending: [] as Array<(r: ExecutionResult) => void>,
}));

vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({
  getJavaScriptExecutor: () => ({
    config: { id: 'javascript', name: 'JavaScript' },
    isInitialized: true,
    run: () => new Promise<ExecutionResult>((resolve) => fake.pending.push(resolve)),
    parseErrors: () => [],
    abort: () => {},
  }),
}));
vi.mock('../../executors/c/CExecutor.js', () => ({
  WasmerSdkCorruptedError: class extends Error {},
  getCExecutor: () => null,
}));
vi.mock('../../executors/cpp/CppExecutor.js', () => ({ getCppExecutor: () => null }));
vi.mock('../../executors/typescript/TypeScriptExecutor.js', () => ({ getTypeScriptExecutor: () => null }));
vi.mock('../../executors/python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

const { CodeExecutionController } = await import('../CodeExecutionController.js');
const { EventRecorder } = await import('../../core/EventRecorder.js');
const { recordToOwnerTab } = await import('../codeExecutionRecording.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (CodeExecution Owner Test)',
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

/** PoSW Web Worker のスタブ (node 環境には Worker が無い)。EventRecorder.test.ts と同じ流儀 */
class MockPoswWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      this.onmessage?.({
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

async function makeTab(id: string, filename: string): Promise<TabState> {
  const typingProof = new TypingProof();
  await typingProof.initialize(await computeHash(JSON.stringify(components)), components);
  return { id, filename, language: 'javascript', typingProof } as unknown as TabState;
}

async function setup() {
  const tabs = new Map<string, TabState>();
  const a = await makeTab('tab-a', 'A.js');
  const b = await makeTab('tab-b', 'B.js');
  tabs.set(a.id, a);
  tabs.set(b.id, b);
  let activeId: string | null = a.id;
  const tabManager = {
    getActiveTab: () => (activeId ? (tabs.get(activeId) ?? null) : null),
    getActiveProof: () => (activeId ? (tabs.get(activeId)?.typingProof ?? null) : null),
    getAllTabs: () => [...tabs.values()],
    getTab: (id: string) => tabs.get(id) ?? null,
    saveToStorage: vi.fn(),
  } as unknown as TabManager;
  const recorder = new EventRecorder({
    tabManager,
    getLogViewer: () => ({ isVisible: false, addLogEntry: vi.fn() }) as unknown as LogViewer,
  });
  recorder.setInitialized(true);

  // main.ts と同じ配線 (setCallbacks の onRecordEvent / handleRunCode)
  const controller = new CodeExecutionController();
  controller.setCallbacks({
    onRecordEvent: (event, ownerTabId) => recordToOwnerTab(recorder, event, ownerTabId),
  });
  const runActiveTab = () => {
    const tab = tabManager.getActiveTab()!;
    return controller.run({
      language: tab.language,
      filename: tab.filename,
      code: 'x',
      ownerTabId: tab.id,
    });
  };

  return {
    a,
    b,
    controller,
    runActiveTab,
    switchTo: (id: string) => {
      activeId = id;
    },
    /** TabManager.closeTab と同じく、タブを外してから active を残りへ移す */
    close: (id: string) => {
      tabs.delete(id);
      if (activeId === id) activeId = tabs.keys().next().value ?? null;
    },
  };
}

function executionData(tab: TabState): CodeExecutionEventData[] {
  return tab.typingProof.events.filter((e) => e.type === 'codeExecution').map((e) => e.data as CodeExecutionEventData);
}

/** 記録は fire-and-forget なので、PoSW の確定まで待つ */
async function settle(...tabs: TabState[]): Promise<void> {
  for (const tab of tabs) await tab.typingProof.waitForQueueDrain();
}

describe('code execution events are recorded to the tab that started the run (#698)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    persistence.saveEventToIndexedDB.mockClear();
    fake.pending = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['success', { success: true, exitCode: 0 }, 'success'],
    ['failure', { success: false, exitCode: 1 }, 'failure'],
  ] as const)(
    'records the %s result to the starting tab even after switching to another tab',
    async (_label, result, outcome) => {
      const { a, b, runActiveTab, switchTo } = await setup();

      const run = runActiveTab();
      await vi.waitFor(() => expect(fake.pending).toHaveLength(1));
      switchTo(b.id);
      fake.pending[0]?.(result as ExecutionResult);
      await run;
      await settle(a, b);

      expect(executionData(a).map((d) => [d.phase, d.filename, d.outcome])).toEqual([
        ['start', 'A.js', undefined],
        ['result', 'A.js', outcome],
      ]);
      expect(executionData(b)).toEqual([]);
    }
  );

  it('records the aborted result to the starting tab when the run is stopped from another tab', async () => {
    const { a, b, controller, runActiveTab, switchTo } = await setup();

    const run = runActiveTab();
    await vi.waitFor(() => expect(fake.pending).toHaveLength(1));
    switchTo(b.id);
    controller.abort();
    fake.pending[0]?.({ success: false, exitCode: 1 } as ExecutionResult);
    await run;
    await settle(a, b);

    expect(executionData(a).map((d) => [d.phase, d.outcome])).toEqual([
      ['start', undefined],
      ['result', 'aborted'],
    ]);
    expect(executionData(b)).toEqual([]);
  });

  it('keeps recording to the starting tab when that tab is renamed during the run', async () => {
    const { a, b, runActiveTab, switchTo } = await setup();

    const run = runActiveTab();
    await vi.waitFor(() => expect(fake.pending).toHaveLength(1));
    // 改名後、もう一方のタブと同じ名前になっても記録先は変わらない
    a.filename = 'B.js';
    switchTo(b.id);
    fake.pending[0]?.({ success: true, exitCode: 0 } as ExecutionResult);
    await run;
    await settle(a, b);

    expect(executionData(a).map((d) => d.phase)).toEqual(['start', 'result']);
    expect(executionData(b)).toEqual([]);
  });

  it('drops the result of a run whose tab was closed instead of moving it to another tab or persisting it', async () => {
    const { a, b, runActiveTab, close } = await setup();

    const run = runActiveTab();
    await vi.waitFor(() => expect(fake.pending).toHaveLength(1));
    await settle(a);
    persistence.saveEventToIndexedDB.mockClear();
    close(a.id);
    fake.pending[0]?.({ success: true, exitCode: 0 } as ExecutionResult);
    await run;
    await settle(a, b);

    expect(executionData(b)).toEqual([]);
    expect(executionData(a).map((d) => d.phase)).toEqual(['start']);
    // 閉じたタブの行を IndexedDB に書き戻さない (書くと閉じたタブが復元で生き返る)
    expect(persistence.saveEventToIndexedDB).not.toHaveBeenCalled();
  });
});
