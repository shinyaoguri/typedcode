/**
 * TabManager の同期状態 (#456)。
 *
 * export は `saveToStorage()` (pending を通知して 100ms のデバウンスタイマーを張る) の直後に
 * `flushToIndexedDB()` を呼ぶ。flush はタイマーを取り消して自分で保存するので、状態を確定させる
 * `executeSave` の完了処理が走らない。flush 自身が状態を確定させないと `pending` が残る。
 * Monaco / Turnstile / IndexedDB は node 環境に無いので境界だけスタブする
 * (セッション未初期化 = saveToIndexedDB は何も書かずに返る)。
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
type SyncStatus = import('../TabManager.js').SyncStatus;

/** private の保存処理と tabs に触るための窓口 */
interface TabManagerInternals {
  saveToIndexedDB: () => Promise<void>;
  tabs: Map<string, unknown>;
}

function setup() {
  const editor = { setModel: vi.fn() };
  const tabManager = new TabManager(editor as unknown as ConstructorParameters<typeof TabManager>[0]);
  const notified: SyncStatus[] = [];
  tabManager.setOnSyncStatusChange((status) => notified.push(status));
  const internals = tabManager as unknown as TabManagerInternals;
  return { tabManager, notified, internals };
}

/** PoSW 待ちのイベントを抱えたタブ (hasPendingEvents と saveToSessionStorage が読む面だけ持つ) */
function tabWithPendingEvents(): unknown {
  return {
    filename: 'a.c',
    language: 'c',
    model: { getValue: () => '' },
    createdAt: 0,
    verificationState: 'pending',
    verificationDetails: undefined,
    typingProof: {
      getPendingEvents: () => [{ type: 'contentChange' }],
      serializeLightweightState: () => ({}),
    },
  };
}

describe('TabManager sync status after flushToIndexedDB (#456)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // saveToSessionStorage が書く先。node 環境には無い
    const store = new Map<string, string>();
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

  it('settles to synced when flushToIndexedDB cancels a debounced save and nothing is left pending', async () => {
    const { tabManager, notified } = setup();

    tabManager.saveToStorage();
    expect(tabManager.getSyncStatus()).toBe('pending');
    await tabManager.flushToIndexedDB();

    expect(notified.at(-1)).toBe('synced');
    expect(tabManager.getSyncStatus()).toBe('synced');
  });

  it('stays pending after flushToIndexedDB while a tab still has PoSW-pending events', async () => {
    const { tabManager, internals } = setup();
    internals.tabs.set('tab-1', tabWithPendingEvents());

    tabManager.saveToStorage();
    await tabManager.flushToIndexedDB();

    expect(tabManager.getSyncStatus()).toBe('pending');
  });

  it('leaves the status to a save requested during the flush, which then settles it to synced', async () => {
    const { tabManager, notified, internals } = setup();
    // flush の保存の await 中に、新しい記録で saveToStorage() が来る
    let requested = false;
    vi.spyOn(internals, 'saveToIndexedDB').mockImplementation(async () => {
      if (!requested) {
        requested = true;
        tabManager.saveToStorage();
      }
    });

    tabManager.saveToStorage();
    await tabManager.flushToIndexedDB();
    expect(tabManager.getSyncStatus()).toBe('pending');

    // 後続の保存 (デバウンス後の executeSave) が状態を確定させる
    await vi.advanceTimersByTimeAsync(100);
    expect(tabManager.getSyncStatus()).toBe('synced');
    expect(notified.at(-1)).toBe('synced');
  });
});
