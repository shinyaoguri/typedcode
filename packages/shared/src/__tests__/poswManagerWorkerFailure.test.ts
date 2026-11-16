/**
 * PoSW Worker の故障 (`Worker.onerror`) の後の振る舞い (#701)。
 *
 * 起動に失敗した Worker (配信物の欠落・CSP など) は二度と応答しない。以前は onerror で pending を
 * reject するだけで同じ個体を持ち続け、後続のイベントごとに 30 秒 (`WORKER_REQUEST_TIMEOUT_MS`) の
 * 期限を待ってからメインスレッドで計算していた (TypingProof は記録を直列化するので、待ちが件数に比例する)。
 * 故障を受けた個体は terminate して捨て、以後は既存の非同期メインスレッド計算へ直行する。
 *
 * Worker は onerror の後に応答しない fake。PoSW の値は本物のメインスレッド計算で焼き、`verifyPoSW` で縛る。
 * 期限のタイマーは fake timers の `getTimerCount` で数える (メインスレッド計算はタイマーを使わない)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingProof, computeHash } from '../index.js';
import { HashChainManager } from '../typingProof/HashChainManager.js';
import { PoswManager, observePoswWorkerFailure } from '../typingProof/PoswManager.js';
import type { FingerprintComponents } from '../types.js';
import { verifyPoSW } from '../verification.js';

/** PoswManager の個別要求の期限 (private static の写し)。 */
const WORKER_REQUEST_TIMEOUT_MS = 30_000;

const previousHash = 'a'.repeat(64);
const eventData = (n: number) => `{"data":"${n}","sequence":${n},"type":"contentChange"}`;

/**
 * postMessage を受けても応答しない Worker。`fail()` で、本物と同じく `onerror` と `addEventListener('error')` の
 * 両方へ error を配る。`null` を渡すとスクリプトの読み込み失敗 (message の無い Event) を模す。
 */
function makeFailingWorker() {
  const listeners: Array<(event: Event) => void> = [];
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === 'error') listeners.push(listener);
    },
    fail(message: string | null = 'worker module failed to load') {
      const event = { type: 'error', message: message ?? undefined } as ErrorEvent;
      worker.onerror?.(event);
      for (const listener of listeners) listener(event);
    },
  };
  return worker;
}

/** 生成直後に故障の観測を始めた Worker (editor の createPoswWorker と同じ形) */
function makeObservedFailingWorker() {
  const worker = makeFailingWorker();
  observePoswWorkerFailure(worker as unknown as Worker);
  return worker;
}

function managerWith(worker: ReturnType<typeof makeFailingWorker>): PoswManager {
  const manager = new PoswManager(new HashChainManager());
  manager.initWorker(worker as unknown as Worker);
  return manager;
}

describe('PoswManager after a fatal worker error (#701)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('completes a request pending at the time of the error through a verifiable main-thread fallback', async () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);

    const pending = manager.computePoSW(previousHash, eventData(1));
    worker.fail();

    expect(await verifyPoSW(previousHash, eventData(1), await pending)).toBe(true);
  });

  it('arms no worker deadline for a request made after the error', async () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);
    worker.fail();

    const later = manager.computePoSW(previousHash, eventData(2));
    const armedTimers = vi.getTimerCount();
    // 赤のとき (期限を張った) でも宙づりにしない
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await later;

    expect(armedTimers).toBe(0);
  });

  it('does not post later requests to a worker that raised a fatal error', async () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);
    const first = manager.computePoSW(previousHash, eventData(1));
    worker.fail();
    await first;

    const later = Promise.all([
      manager.computePoSW(previousHash, eventData(2)),
      manager.computePoSW(previousHash, eventData(3)),
    ]);
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await later;

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('terminates a worker that raised a fatal error', () => {
    const worker = makeFailingWorker();
    managerWith(worker);

    worker.fail();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('leaves no deadline timer behind for requests pending at the time of the error', async () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);
    const pending = Promise.all([
      manager.computePoSW(previousHash, eventData(1)),
      manager.computePoSW(previousHash, eventData(2)),
    ]);

    worker.fail();
    const leftTimers = vi.getTimerCount();
    await pending;

    expect(leftTimers).toBe(0);
  });

  it('gives every later computation a PoSW that verifies against its own input', async () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);
    worker.fail();

    const inputs = [3, 4, 5].map((n) => [`${n}`.repeat(64), eventData(n)] as const);
    const results = Promise.all(inputs.map(([prev, data]) => manager.computePoSW(prev, data)));
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    const posws = await results;

    const verdicts = await Promise.all(inputs.map(([prev, data], i) => verifyPoSW(prev, data, posws[i]!)));
    expect(verdicts).toEqual([true, true, true]);
  });

  it('does not take up another worker once a worker has raised a fatal error', async () => {
    const failed = makeFailingWorker();
    const manager = managerWith(failed);
    failed.fail();
    const replacement = makeFailingWorker();
    manager.initWorker(replacement as unknown as Worker);

    const later = manager.computePoSW(previousHash, eventData(2));
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await later;

    expect(replacement.postMessage).not.toHaveBeenCalled();
  });

  it('does not terminate a failed worker again on dispose (#342)', () => {
    const worker = makeFailingWorker();
    const manager = managerWith(worker);
    worker.fail();

    manager.dispose();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('PoswManager with a worker that failed before it was attached (#701)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 生成 → 故障 (script の読み込み失敗) → attach の順。editor が Turnstile を待つ間に起きる形 */
  function managerWithWorkerFailedBeforeAttach() {
    const worker = makeObservedFailingWorker();
    worker.fail(null);
    return { worker, manager: managerWith(worker) };
  }

  it('arms no worker deadline for the first request', async () => {
    const { manager } = managerWithWorkerFailedBeforeAttach();

    const first = manager.computePoSW(previousHash, eventData(1));
    const armedTimers = vi.getTimerCount();
    // 赤のとき (期限を張った) でも宙づりにしない
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await first;

    expect(armedTimers).toBe(0);
  });

  it('does not post any request to the worker', async () => {
    const { worker, manager } = managerWithWorkerFailedBeforeAttach();

    const first = manager.computePoSW(previousHash, eventData(1));
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await first;

    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('terminates the worker when it is attached', () => {
    const { worker } = managerWithWorkerFailedBeforeAttach();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('gives the first request a PoSW that verifies against its input', async () => {
    const { manager } = managerWithWorkerFailedBeforeAttach();

    const first = manager.computePoSW(previousHash, eventData(1));
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);

    expect(await verifyPoSW(previousHash, eventData(1), await first)).toBe(true);
  });

  it('keeps using a worker whose observation saw no error', async () => {
    const worker = makeObservedFailingWorker();
    const manager = managerWith(worker);

    void manager.computePoSW(previousHash, eventData(1));

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('cleans up a failure after attach once, through onerror', () => {
    const worker = makeObservedFailingWorker();
    const manager = managerWith(worker);

    worker.fail();
    manager.dispose();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('PoswManager worker error reason (#701)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an error event without a message as a failure to start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = makeFailingWorker();
    const manager = managerWith(worker);

    const pending = manager.computePoSW(previousHash, eventData(1));
    worker.fail(null);
    await pending;

    expect(String(warn.mock.calls[0]?.[1])).toBe('Error: Worker error: Worker failed to start');
  });
});

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (PoswWorkerFailure Test)',
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

describe('TypingProof with a PoSW worker that failed to start (#701)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records several events in order without waiting on the failed worker', async () => {
    const worker = makeFailingWorker();
    const proof = new TypingProof();
    await proof.initialize(await computeHash(JSON.stringify(components)), components, worker as unknown as Worker);
    worker.fail();

    // editor と同じく、前の記録を待たずに続けて投げる (記録は TypingProof が直列化する)
    const results = await Promise.all(
      ['a', 'b', 'c'].map((data) => proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data }))
    );

    expect({
      recorded: results.map((r) => r.recorded),
      data: proof.events.map((e) => e.data),
      sequences: proof.events.map((e) => e.sequence),
    }).toEqual({ recorded: [true, true, true], data: ['a', 'b', 'c'], sequences: [0, 1, 2] });
  }, 10_000);

  it('catches a worker failure that happens while initialize is still awaiting', async () => {
    const worker = makeObservedFailingWorker();
    const proof = new TypingProof();
    const initializing = proof.initialize(
      await computeHash(JSON.stringify(components)),
      components,
      worker as unknown as Worker
    );
    // initialize は root の計算を await してから Worker を attach する。その間に読み込み失敗が届く
    worker.fail(null);
    await initializing;

    await proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: 'a' });

    expect(worker.postMessage).not.toHaveBeenCalled();
  }, 10_000);
});
