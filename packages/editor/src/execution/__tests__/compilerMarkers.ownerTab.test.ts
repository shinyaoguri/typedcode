/**
 * 実行の診断マーカーが、表示中のタブではなく実行を始めたタブのモデルに付く・消えることの検査 (#741)。
 *
 * CodeExecutionController → showErrorsInOwnerTab / clearErrorsInOwnerTab を main.ts と同じ配線で
 * 2 タブにつなぐ。差し替えるのは言語ランタイム (結果と stderr をテストが手で出す)・TabManager
 * (タブの出し入れだけのスタブ)・Monaco の setModelMarkers (モデルごとに最後のマーカーを覚える) だけ。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionCallbacks, ExecutionResult, ParsedError } from '../../executors/interfaces/ILanguageExecutor.js';
import type { ExecutionMarker, MarkerModel } from '../compilerMarkers.js';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));

/** 偽の executor の run: stderr はテストが callbacks から出し、結果はテストが手で解決する */
const fake = vi.hoisted(() => ({
  runs: [] as Array<{ callbacks: ExecutionCallbacks; resolve: (r: ExecutionResult) => void }>,
}));

const COMPILE_ERROR: ParsedError = { line: 1, column: 1, severity: 'error', message: 'expected ;' };

vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({
  getJavaScriptExecutor: () => ({
    config: { id: 'javascript', name: 'JavaScript' },
    isInitialized: true,
    run: (_code: string, callbacks: ExecutionCallbacks) =>
      new Promise<ExecutionResult>((resolve) => fake.runs.push({ callbacks, resolve })),
    parseErrors: (text: string) => (text ? [COMPILE_ERROR] : []),
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
const { showErrorsInOwnerTab, clearErrorsInOwnerTab } = await import('../compilerMarkers.js');

interface FakeModel extends MarkerModel {
  dispose(): void;
}

function makeModel(): FakeModel {
  let disposed = false;
  return {
    getLineCount: () => 3,
    getLineMaxColumn: () => 10,
    isDisposed: () => disposed,
    dispose: () => {
      disposed = true;
    },
  };
}

interface FakeTab {
  id: string;
  model: FakeModel;
}

function setup() {
  const tabs = new Map<string, FakeTab>([
    ['tab-a', { id: 'tab-a', model: makeModel() }],
    ['tab-b', { id: 'tab-b', model: makeModel() }],
  ]);
  const a = tabs.get('tab-a')!;
  const b = tabs.get('tab-b')!;
  let activeId: string | null = a.id;
  const tabManager = { getTab: (id: string) => tabs.get(id) ?? null };

  /** Monaco と同じく、モデルごとに owner の最後のマーカーだけが残る。dispose 済みのモデルには throw する */
  const markers = new Map<FakeModel, ExecutionMarker[]>();
  const setModelMarkers = vi.fn((model: FakeModel, _owner: string, next: ExecutionMarker[]) => {
    if (model.isDisposed()) throw new Error('setModelMarkers on a disposed model');
    markers.set(model, next);
  });

  // main.ts と同じ配線 (setCallbacks の onShowErrors / onClearErrors と handleRunCode)
  const controller = new CodeExecutionController();
  controller.setCallbacks({
    onShowErrors: (errors, ownerTabId) => showErrorsInOwnerTab(tabManager, ownerTabId, errors, setModelMarkers),
    onClearErrors: (ownerTabId) => clearErrorsInOwnerTab(tabManager, ownerTabId, setModelMarkers),
  });
  const runActiveTab = () => {
    const tab = tabs.get(activeId!)!;
    return controller.run({ language: 'javascript', filename: `${tab.id}.js`, code: 'x', ownerTabId: tab.id });
  };
  /** 実行中の run を、stderr (空なら出さない) を出してから終わらせる */
  const finishRun = async (run: Promise<void>, stderr: string) => {
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    const current = fake.runs.shift()!;
    if (stderr) current.callbacks.onStderr(stderr);
    current.resolve({ success: !stderr, exitCode: stderr ? 1 : 0, stdout: '', stderr });
    await run;
  };

  return {
    a,
    b,
    markers,
    setModelMarkers,
    runActiveTab,
    finishRun,
    switchTo: (id: string) => {
      activeId = id;
    },
    /**
     * TabManager.closeTab と同じく、タブのモデルを dispose して外し、active を残りへ移す。
     * `keepListed` は dispose 済みのモデルを持つタブがまだ引ける状態 (閉じる途中) を作る
     */
    close: (id: string, keepListed = false) => {
      tabs.get(id)?.model.dispose();
      if (!keepListed) tabs.delete(id);
      if (activeId === id) activeId = tabs.keys().next().value ?? null;
    },
  };
}

beforeEach(() => {
  fake.runs = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('execution diagnostics mark the tab that started the run (#741)', () => {
  it('puts the markers on the starting tab even after switching to another tab before the result', async () => {
    const { a, b, markers, runActiveTab, finishRun, switchTo } = setup();

    const run = runActiveTab();
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    switchTo(b.id);
    await finishRun(run, 'main.js:1:1: error: expected ;');

    expect(markers.get(a.model)).toEqual([expect.objectContaining({ severity: 'error', message: 'expected ;' })]);
    expect(markers.has(b.model)).toBe(false);
  });

  it('keeps the markers of a tab through runs of other tabs and clears them when that tab runs again', async () => {
    const { a, b, markers, runActiveTab, finishRun, switchTo } = setup();
    await finishRun(runActiveTab(), 'main.js:1:1: error: expected ;');

    switchTo(b.id);
    await finishRun(runActiveTab(), '');
    expect(markers.get(a.model)).toHaveLength(1);
    expect(markers.get(b.model)).toEqual([]);

    switchTo(a.id);
    await finishRun(runActiveTab(), '');
    expect(markers.get(a.model)).toEqual([]);
  });

  it.each([
    ['removed', false],
    ['still listed with a disposed model', true],
  ] as const)(
    'does nothing when the starting tab was closed (%s) before its diagnostics arrive',
    async (_label, keepListed) => {
      const { a, b, markers, setModelMarkers, runActiveTab, finishRun, close } = setup();

      const run = runActiveTab();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      setModelMarkers.mockClear();
      close(a.id, keepListed);
      await finishRun(run, 'main.js:1:1: error: expected ;');

      expect(setModelMarkers).not.toHaveBeenCalled();
      expect(markers.has(b.model)).toBe(false);
    }
  );
});
