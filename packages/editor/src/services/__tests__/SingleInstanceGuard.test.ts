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

describe('SingleInstanceGuard instanceId', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // becomeActive が beforeunload を登録する (node 環境には window が無い)
    vi.stubGlobal('window', { addEventListener: vi.fn() });
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
