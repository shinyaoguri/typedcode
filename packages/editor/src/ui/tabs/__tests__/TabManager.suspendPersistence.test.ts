/**
 * TabManager.suspendPersistence (#323)。
 *
 * リセットは DB の削除の完了を待ってからリロードする。その間にデバウンス中・実行中の保存が
 * sessionStorage へ書くと、消したはずのタブ状態がリロードで復元される。確定後はどの経路
 * (デバウンス・同期保存・flush) からも sessionStorage に書かないことを固定する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('monaco-editor', () => ({
  editor: {
    createModel: (content: string) => ({ getValue: () => content }),
    setModelLanguage: () => {},
  },
}));

vi.mock('../../../services/TurnstileService.js', () => ({
  isTurnstileConfigured: () => false,
  performTurnstileVerification: vi.fn(),
}));

vi.mock('../TabVerificationUI.js', () => ({
  performVerificationWithUI: vi.fn(),
}));

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => null,
    isInitialized: () => false,
  }),
}));

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { TabManager } = await import('../TabManager.js');

describe('TabManager.suspendPersistence (#323)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const editor = { setModel: vi.fn() };
    return new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  }

  it('writes the tab state to sessionStorage before suspension (baseline)', async () => {
    const tabManager = setup();

    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(200);

    expect(store.has('typedcode-tabs')).toBe(true);
  });

  it('drops a debounced save that was already scheduled when persistence is suspended', async () => {
    const tabManager = setup();

    tabManager.saveToStorage();
    tabManager.suspendPersistence();
    await vi.advanceTimersByTimeAsync(200);

    expect(store.has('typedcode-tabs')).toBe(false);
  });

  it('writes nothing to sessionStorage from saveToStorage, saveToStorageSync or flushToIndexedDB afterwards', async () => {
    const tabManager = setup();
    tabManager.suspendPersistence();

    tabManager.saveToStorage();
    tabManager.saveToStorageSync();
    await tabManager.flushToIndexedDB();
    await vi.advanceTimersByTimeAsync(200);

    expect(store.has('typedcode-tabs')).toBe(false);
  });
});
