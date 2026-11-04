/**
 * SingleInstanceGuard のテスト (#268 / #494)。
 *
 * 既存インスタンスの判定は Web Locks (`navigator.locks`) で行い、無い環境 (と request が
 * 失敗したとき) だけ BroadcastChannel の ping → pong に戻る (#494)。
 *
 * instanceId の権威は永続化される SessionStorageService 側で、ガードは自前で UUID を
 * 生成せずそれを使う (2 つの別 UUID が並ぶと「このタブは誰か」が一意に決まらない)。
 * 起動レースの順序決め (ping の senderId の大小比較) もこの id で行うので、ping の senderId が
 * getInstanceId() の値であることを確かめる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionStorageService } from '../SessionStorageService.js';
import { SingleInstanceGuard } from '../SingleInstanceGuard.js';

type Handler = (event: MessageEvent) => void;

/** postMessage の中身を記録するだけの最小の BroadcastChannel モック */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly posted: unknown[] = [];
  private handlers: Handler[] = [];

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: string, handler: Handler): void {
    this.handlers.push(handler);
  }

  removeEventListener(_type: string, handler: Handler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  close(): void {}

  /** 他のインスタンスからのメッセージが届いたことにする */
  receive(data: unknown): void {
    for (const handler of this.handlers) handler({ data } as MessageEvent);
  }
}

type LockCallback = (lock: { name: string } | null) => unknown;

/**
 * Web Locks の最小のモック。排他ロックを名前で持ち、`ifAvailable` で取れなければ callback に null を渡す。
 * callback の返した Promise が settle したら解放する (実物と同じ)。
 */
class FakeLockManager {
  readonly held = new Set<string>();
  rejectWith: Error | null = null;

  async request(name: string, options: { ifAvailable?: boolean }, callback: LockCallback): Promise<unknown> {
    if (this.rejectWith) throw this.rejectWith;
    if (!options.ifAvailable) throw new Error('the guard must not queue for the lock');
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

let windowListeners: Record<string, Array<(e: unknown) => void>> = {};
const fire = (type: string, event: unknown = {}): void => {
  for (const listener of windowListeners[type] ?? []) listener(event);
};

describe('SingleInstanceGuard instanceId (ping/pong fallback without Web Locks)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // Web Locks の無い環境 (ping → pong に戻る経路)
    vi.stubGlobal('navigator', {});
    // becomeActive がページ離脱のリスナーを登録する (node 環境には window が無い)
    windowListeners = {};
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (e: unknown) => void) => {
        const listeners = windowListeners[type] ?? [];
        listeners.push(listener);
        windowListeners[type] = listeners;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends ping with the SessionStorageService instanceId as senderId', async () => {
    const guard = new SingleInstanceGuard('test');
    const pending = guard.checkForExistingInstance();

    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe('typedcode-instance-guard:test');
    expect(channel.posted).toEqual([{ type: 'ping', senderId: getSessionStorageService().getInstanceId() }]);

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(false);
    guard.dispose();
  });

  it('ignores its own messages (same senderId) but yields to an active instance that answers pong', async () => {
    const own = getSessionStorageService().getInstanceId();
    const guard = new SingleInstanceGuard();
    const pending = guard.checkForExistingInstance();
    const channel = FakeBroadcastChannel.instances[0]!;

    // 自分の id のメッセージは無視される (一本化した id で自己エコーを弾く)
    channel.receive({ type: 'pong', senderId: own });
    channel.receive({ type: 'pong', senderId: 'other-instance' });

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(true);
  });
});

/**
 * 破棄のタイミング (#483)。beforeunload は離脱確認で「このページに留まる」を選ぶと、アンロードが
 * 起きないのに発火済みになる。そこで破棄すると、生きているページのガードだけが外れて 2 つ目のタブが
 * 正規インスタンスとして起動できてしまう。確実に離れるときだけ発火する pagehide で破棄する。
 */
describe('SingleInstanceGuard disposal timing', () => {
  let locks: FakeLockManager;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    windowListeners = {};
    locks = new FakeLockManager();
    vi.stubGlobal('navigator', { locks });
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (e: unknown) => void) => {
        const listeners = windowListeners[type] ?? [];
        listeners.push(listener);
        windowListeners[type] = listeners;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function activate(): Promise<SingleInstanceGuard> {
    const guard = new SingleInstanceGuard('test');
    await expect(guard.checkForExistingInstance()).resolves.toBe(false);
    return guard;
  }

  it('keeps the guard active when beforeunload fires but the user stays on the page', async () => {
    const guard = await activate();

    fire('beforeunload');

    expect(guard.getIsActive()).toBe(true);
    guard.dispose();
  });

  it('disposes the guard and releases its lock on pagehide when the page is really being unloaded (persisted=false)', async () => {
    const guard = await activate();

    fire('pagehide', { persisted: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(guard.getIsActive()).toBe(false);
    expect(locks.held.has(LOCK_NAME)).toBe(false);
  });

  it('keeps the guard and its lock when pagehide enters the bfcache (persisted=true), so a restored page is still guarded', async () => {
    const guard = await activate();

    fire('pagehide', { persisted: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(guard.getIsActive()).toBe(true);
    expect(locks.held.has(LOCK_NAME)).toBe(true);
    guard.dispose();
  });
});

const LOCK_NAME = 'typedcode-instance-guard:test';

/**
 * Web Locks による判定 (#494)。window.open で開いた popup は開いた側と同じ main thread で動くので、
 * 開かれた側の初期化が長いと開いた側は ping に 500ms 以内に答えられない。lock は時間に依存しないので、
 * 持っているページが応答できなくても既存ありと判定できる。
 */
describe('SingleInstanceGuard with Web Locks', () => {
  let locks: FakeLockManager;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    windowListeners = {};
    locks = new FakeLockManager();
    vi.stubGlobal('navigator', { locks });
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (e: unknown) => void) => {
        const listeners = windowListeners[type] ?? [];
        listeners.push(listener);
        windowListeners[type] = listeners;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports an existing instance when the lock is held elsewhere, without waiting for a pong that never comes', async () => {
    locks.held.add(LOCK_NAME);
    const guard = new SingleInstanceGuard('test');

    // 時間を進めない: 判定は pong の待ち時間に依存しない
    await expect(guard.checkForExistingInstance()).resolves.toBe(true);
    expect(guard.getIsActive()).toBe(false);
  });

  it('holds the per-mode lock while active, blocks a later instance, and releases the lock on dispose', async () => {
    const first = new SingleInstanceGuard('test');
    await expect(first.checkForExistingInstance()).resolves.toBe(false);
    expect(locks.held.has(LOCK_NAME)).toBe(true);
    // 別モードの lock は別名なので取れる
    await expect(new SingleInstanceGuard('other').checkForExistingInstance()).resolves.toBe(false);

    await expect(new SingleInstanceGuard('test').checkForExistingInstance()).resolves.toBe(true);

    first.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(locks.held.has(LOCK_NAME)).toBe(false);
    await expect(new SingleInstanceGuard('test').checkForExistingInstance()).resolves.toBe(false);
  });

  it('still answers pings while holding the lock, so instances on the ping/pong fallback see it', async () => {
    const guard = new SingleInstanceGuard('test');
    await expect(guard.checkForExistingInstance()).resolves.toBe(false);
    const channel = FakeBroadcastChannel.instances[0]!;

    channel.receive({ type: 'ping', senderId: 'other-instance' });

    expect(channel.posted).toContainEqual({ type: 'pong', senderId: getSessionStorageService().getInstanceId() });
    guard.dispose();
  });

  it('falls back to ping/pong when the lock request itself fails', async () => {
    locks.rejectWith = new Error('SecurityError');
    const guard = new SingleInstanceGuard('test');
    const pending = guard.checkForExistingInstance();
    await vi.advanceTimersByTimeAsync(0);
    const channel = FakeBroadcastChannel.instances[0]!;

    channel.receive({ type: 'pong', senderId: 'other-instance' });
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBe(true);
  });
});
