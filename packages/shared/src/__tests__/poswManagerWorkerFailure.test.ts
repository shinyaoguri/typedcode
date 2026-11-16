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
import { PoswManager } from '../typingProof/PoswManager.js';
import type { FingerprintComponents } from '../types.js';
import { verifyPoSW } from '../verification.js';

/** PoswManager の個別要求の期限 (private static の写し)。 */
const WORKER_REQUEST_TIMEOUT_MS = 30_000;

const previousHash = 'a'.repeat(64);
const eventData = (n: number) => `{"data":"${n}","sequence":${n},"type":"contentChange"}`;

/** postMessage を受けても応答しない Worker。`fail()` で onerror を起こす。 */
function makeFailingWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    fail(message = 'worker module failed to load') {
      worker.onerror?.({ message } as ErrorEvent);
    },
  };
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
});
