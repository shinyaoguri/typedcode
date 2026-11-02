/**
 * コード実行の結果 (ADR-0021) が、実際のハッシュチェーンに data ごと載ることの検査 (#491)。
 *
 * CodeExecutionController → toRecordEventInput → EventRecorder → TypingProof の経路を
 * 本物のまま通す。差し替えるのは言語ランタイム (Wasmer / Worker など) と永続化だけ。
 * main.ts の onRecordEvent が data を落とすと、export した proof の codeExecution が全件
 * data: null になり、processSummary は実行結果を「不明」と読む。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingProof, computeHash, summarizeProcess } from '@typedcode/shared';
import type { CodeExecutionEventData, FingerprintComponents } from '@typedcode/shared';
import type { TabManager } from '../../ui/tabs/TabManager.js';
import type { LogViewer } from '../../ui/components/LogViewer.js';
import type { ExecutionResult } from '../../executors/interfaces/ILanguageExecutor.js';

const persistence = vi.hoisted(() => ({
  saveEventToIndexedDB: vi.fn(async () => {}),
  saveTabsToSessionStorage: vi.fn(),
}));

vi.mock('../../core/EventPersistence.js', () => ({
  EventPersistence: class {
    saveEventToIndexedDB = persistence.saveEventToIndexedDB;
    saveTabsToSessionStorage = persistence.saveTabsToSessionStorage;
  },
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

/** 次の run() の振る舞い。テストごとに差し替える */
const fakeRun = vi.hoisted(() => ({
  impl: async (): Promise<ExecutionResult> => ({ success: true, exitCode: 0 }) as ExecutionResult,
}));

vi.mock('../../executors/c/CExecutor.js', () => ({
  WasmerSdkCorruptedError: class WasmerSdkCorruptedError extends Error {},
  getCExecutor: () => ({
    config: { id: 'c', name: 'C' },
    isInitialized: true,
    run: () => fakeRun.impl(),
    parseErrors: () => [],
    abort: () => {},
  }),
}));
vi.mock('../../executors/cpp/CppExecutor.js', () => ({ getCppExecutor: () => null }));
vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({ getJavaScriptExecutor: () => null }));
vi.mock('../../executors/typescript/TypeScriptExecutor.js', () => ({ getTypeScriptExecutor: () => null }));
vi.mock('../../executors/python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

const { CodeExecutionController } = await import('../CodeExecutionController.js');
const { EventRecorder } = await import('../../core/EventRecorder.js');
const { toRecordEventInput } = await import('../codeExecutionRecording.js');

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (CodeExecution Test)',
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

async function setup() {
  const typingProof = new TypingProof();
  await typingProof.initialize(await computeHash(JSON.stringify(components)), components);
  const tab = { id: 'tab-1', typingProof };
  const tabManager = {
    getActiveTab: () => tab,
    getActiveProof: () => typingProof,
    getAllTabs: () => [tab],
    saveToStorage: vi.fn(),
  } as unknown as TabManager;
  const logViewer = { isVisible: false, addLogEntry: vi.fn() } as unknown as LogViewer;
  const recorder = new EventRecorder({ tabManager, getLogViewer: () => logViewer });
  recorder.setInitialized(true);

  // main.ts と同じ配線 (setCallbacks の onRecordEvent)
  const controller = new CodeExecutionController();
  controller.setCallbacks({ onRecordEvent: (event) => recorder.record(toRecordEventInput(event)) });
  return { typingProof, controller };
}

/** チェーンに載った codeExecution の data を、載った順に返す */
async function recordedExecutionData(typingProof: TypingProof, expectedCount: number) {
  await vi.waitFor(() =>
    expect(typingProof.events.filter((e) => e.type === 'codeExecution')).toHaveLength(expectedCount)
  );
  return typingProof.events.filter((e) => e.type === 'codeExecution').map((e) => e.data as CodeExecutionEventData);
}

describe('code execution results reach the hash chain with their data (ADR-0021, #491)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', MockPoswWorker);
    persistence.saveEventToIndexedDB.mockClear();
    fakeRun.impl = async () => ({ success: true, exitCode: 0 }) as ExecutionResult;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records a start and a success result with phase / outcome / exitCode / elapsedMs in the chain', async () => {
    const { typingProof, controller } = await setup();

    await controller.run({ language: 'c', filename: 'hello.c', code: 'int main(){}' });

    const [start, result] = await recordedExecutionData(typingProof, 2);
    expect(start).toEqual({ phase: 'start', filename: 'hello.c', language: 'c' });
    expect(result).toMatchObject({
      phase: 'result',
      filename: 'hello.c',
      language: 'c',
      outcome: 'success',
      exitCode: 0,
    });
    expect(typeof result?.elapsedMs).toBe('number');
  });

  it('records outcome failure with the non-zero exit code when the program fails to build or run', async () => {
    const { typingProof, controller } = await setup();
    fakeRun.impl = async () => ({ success: false, exitCode: 1 }) as ExecutionResult;

    await controller.run({ language: 'c', filename: 'bad.c', code: 'oops' });

    const [, result] = await recordedExecutionData(typingProof, 2);
    expect(result).toMatchObject({ phase: 'result', outcome: 'failure', exitCode: 1 });
  });

  it('records outcome aborted with a null exit code when the user stops the run', async () => {
    const { typingProof, controller } = await setup();
    let finishRun: (r: ExecutionResult) => void = () => {};
    fakeRun.impl = () => new Promise<ExecutionResult>((resolve) => (finishRun = resolve));

    const running = controller.run({ language: 'c', filename: 'loop.c', code: 'for(;;);' });
    await vi.waitFor(() => expect(controller.running).toBe(true));
    controller.abort();
    finishRun({ success: false, exitCode: 1 } as ExecutionResult);
    await running;

    const [, result] = await recordedExecutionData(typingProof, 2);
    expect(result).toMatchObject({ phase: 'result', outcome: 'aborted', exitCode: null });
  });

  it('lets summarizeProcess read the run results from the recorded chain (hasRunResults, failure then success)', async () => {
    const { typingProof, controller } = await setup();

    fakeRun.impl = async () => ({ success: false, exitCode: 1 }) as ExecutionResult;
    await controller.run({ language: 'c', filename: 'a.c', code: 'x' });
    fakeRun.impl = async () => ({ success: true, exitCode: 0 }) as ExecutionResult;
    await controller.run({ language: 'c', filename: 'a.c', code: 'y' });
    await recordedExecutionData(typingProof, 4);

    const summary = summarizeProcess(typingProof.events);

    expect(summary.hasRunResults).toBe(true);
    expect(summary.executionCount).toBe(2);
    expect(summary.runFailureCount).toBe(1);
    expect(summary.runSuccessCount).toBe(1);
  });
});
