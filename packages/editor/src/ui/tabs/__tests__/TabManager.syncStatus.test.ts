/**
 * TabManager の同期状態 (#456)。
 *
 * export は `saveToStorage()` (pending を通知して 100ms のデバウンスタイマーを張る) の直後に
 * `flushToIndexedDB()` を呼ぶ。flush はタイマーを取り消して自分で保存するので、状態を確定させる
 * `executeSave` の完了処理が走らない。flush 自身が状態を確定させないと `pending` が残る。
 * Monaco / Turnstile / IndexedDB は node 環境に無いので境界だけスタブする
 * (既定はセッション未初期化 = saveToIndexedDB は何も書かずに返る)。
 *
 * 保存の失敗 (#543): 同期状態は永続化の成否を表す。IndexedDB と sessionStorage の両方が失敗したら
 * `failed`、片方だけなら `degraded`。失敗中は打鍵 (`pending`)・保存開始 (`syncing`) で表示を上書きせず、
 * 2 秒から倍々の間隔で再試行し、書けるようになったら `synced` に戻る。
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

/** セッション保存層のスタブの状態。`initialized` にすると saveToIndexedDB が updateTabOrder を書く */
const session = vi.hoisted(() => ({
  initialized: false,
  failWrites: false,
  /** updateTabOrder を呼んだ回数 = IndexedDB への保存を試みた回数 (タブ 0 本なら 1 回の保存で 1 回) */
  writes: 0,
}));

vi.mock('../../../services/SessionStorageService.js', () => ({
  getSessionStorageService: () => ({
    getCurrentSessionId: () => (session.initialized ? 'session-1' : null),
    isInitialized: () => session.initialized,
    updateActiveTabId: async () => {},
    updateTabOrder: async () => {
      session.writes += 1;
      if (session.failWrites) throw new Error('Failed to put to sessions: AbortError');
    },
  }),
  EventChainConflictError: class extends Error {},
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

/** saveToSessionStorage が書く先 (node 環境には無い)。`fail` を立てると setItem が QuotaExceeded を投げる */
const storage = { fail: false };

function stubSessionStorage(): void {
  storage.fail = false;
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.fail) throw new Error('QuotaExceededError');
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
  });
}

describe('TabManager sync status after flushToIndexedDB (#456)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    session.initialized = false;
    session.failWrites = false;
    stubSessionStorage();
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

describe('TabManager sync status when saving fails (#543)', () => {
  /** デバウンス (100ms) を過ぎて executeSave が 1 回走り切るまで進める */
  const DEBOUNCE_MS = 100;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    session.initialized = true;
    session.failWrites = false;
    session.writes = 0;
    stubSessionStorage();
    // 失敗の経路はログを出す (中身はこのテストの関心ではない)
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('becomes failed when neither IndexedDB nor sessionStorage can be written', async () => {
    const { tabManager } = setup();
    session.failWrites = true;
    storage.fail = true;

    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tabManager.getSyncStatus()).toBe('failed');
  });

  it('becomes degraded when only IndexedDB fails and sessionStorage still takes the save', async () => {
    const { tabManager } = setup();
    session.failWrites = true;

    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tabManager.getSyncStatus()).toBe('degraded');
  });

  it('becomes degraded when only sessionStorage fails and IndexedDB still takes the save', async () => {
    const { tabManager } = setup();
    storage.fail = true;

    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tabManager.getSyncStatus()).toBe('degraded');
  });

  it('keeps showing the failure instead of pending or syncing while new saves are requested and keep failing', async () => {
    const { tabManager, notified } = setup();
    session.failWrites = true;
    storage.fail = true;
    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const failedAt = notified.length;

    tabManager.saveToStorage();
    expect(tabManager.getSyncStatus()).toBe('failed');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tabManager.getSyncStatus()).toBe('failed');
    expect(notified.slice(failedAt)).toEqual([]);
  });

  it('retries a failed save after 2 seconds and then after 4 more seconds while it keeps failing', async () => {
    const { tabManager } = setup();
    session.failWrites = true;
    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(session.writes).toBe(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(session.writes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.writes).toBe(2);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(session.writes).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.writes).toBe(3);
  });

  it('caps the retry interval at 60 seconds', async () => {
    const { tabManager } = setup();
    session.failWrites = true;
    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // 2 + 4 + 8 + 16 + 32 秒の再試行を済ませると、次の間隔は 64 秒ではなく 60 秒になる
    await vi.advanceTimersByTimeAsync(62_000);
    expect(session.writes).toBe(6);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(session.writes).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.writes).toBe(7);
  });

  it('returns to synced on the retry once IndexedDB can be written again', async () => {
    const { tabManager, notified } = setup();
    session.failWrites = true;
    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(tabManager.getSyncStatus()).toBe('degraded');

    session.failWrites = false;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(tabManager.getSyncStatus()).toBe('synced');
    expect(notified.at(-1)).toBe('synced');
  });

  it('stops retrying after suspendPersistence', async () => {
    const { tabManager } = setup();
    session.failWrites = true;
    tabManager.saveToStorage();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    tabManager.suspendPersistence();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(session.writes).toBe(1);
  });

  it('flushToIndexedDB resolves with the failure instead of rejecting when IndexedDB cannot be written', async () => {
    const { tabManager } = setup();
    session.failWrites = true;

    const outcome = await tabManager.flushToIndexedDB();

    expect(outcome).toMatchObject({ idbOk: false, sessionStorageOk: true });
    expect(tabManager.getSyncStatus()).toBe('degraded');
  });
});
