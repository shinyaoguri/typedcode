/**
 * SingleInstanceGuard のテスト (#268)。
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

let windowListeners: Record<string, Array<(e: unknown) => void>> = {};
const fire = (type: string, event: unknown = {}): void => {
  for (const listener of windowListeners[type] ?? []) listener(event);
};

describe('SingleInstanceGuard instanceId', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
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
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    windowListeners = {};
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
    const pending = guard.checkForExistingInstance();
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(false);
    return guard;
  }

  it('keeps the guard active when beforeunload fires but the user stays on the page', async () => {
    const guard = await activate();

    fire('beforeunload');

    expect(guard.getIsActive()).toBe(true);
    guard.dispose();
  });

  it('disposes the guard on pagehide when the page is really being unloaded (persisted=false)', async () => {
    const guard = await activate();

    fire('pagehide', { persisted: false });

    expect(guard.getIsActive()).toBe(false);
  });

  it('keeps the guard when pagehide enters the bfcache (persisted=true), so a restored page is still guarded', async () => {
    const guard = await activate();

    fire('pagehide', { persisted: true });

    expect(guard.getIsActive()).toBe(true);
    guard.dispose();
  });
});
