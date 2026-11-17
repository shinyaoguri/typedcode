/**
 * 計算中の要求があるときの PoswManager.dispose (#735)。
 *
 * 以前の dispose は Worker を terminate して pending の map を消すだけで、要求を settle しなかった。
 * 破棄の時点で飛んでいた要求は、期限のタイマー (`WORKER_REQUEST_TIMEOUT_MS` = 30 秒) が切れてから
 * メインスレッドのフォールバックに回り、閉じたタブのためのタイマーと計算が破棄後に残っていた。
 * いまは pending をそれぞれ 1 度だけ reject し (期限のタイマーも解除される)、その場でフォールバックする。
 * 「記録を落とさない」保証は変えない (イベントはチェーンに載る)。変わるのは時期だけ。
 *
 * Worker は応答しない fake。PoSW の値は本物のメインスレッド計算で焼き、`verifyPoSW` で縛る。
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

/** fake timers に差し替えられる前の setTimeout。赤のとき (settle しない) を有限時間で見切るのに使う */
const realSetTimeout = globalThis.setTimeout;

const previousHash = 'a'.repeat(64);
const eventData = `{"data":"a","sequence":1,"type":"contentChange"}`;

/** postMessage を受けても応答しない Worker */
function makeSilentWorker() {
  return {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
  };
}

function managerWith(worker: ReturnType<typeof makeSilentWorker>): PoswManager {
  const manager = new PoswManager(new HashChainManager());
  manager.initWorker(worker as unknown as Worker);
  return manager;
}

/** promise が実時間 `ms` 以内に決着したか (fake timers を進めずに見る) */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'still pending'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'still pending'>((resolve) => realSetTimeout(() => resolve('still pending'), ms)),
  ]);
}

describe('PoswManager.dispose with a request in flight (#735)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('settles a request pending at dispose without waiting for the worker deadline', async () => {
    const manager = managerWith(makeSilentWorker());
    const pending = manager.computePoSW(previousHash, eventData);

    manager.dispose();

    expect(await settlesWithin(pending, 5_000)).toBe('settled');
  }, 10_000);

  it('leaves no deadline timer behind after dispose', async () => {
    const manager = managerWith(makeSilentWorker());
    const pending = manager.computePoSW(previousHash, eventData);

    manager.dispose();
    const leftTimers = vi.getTimerCount();
    // 赤のとき (期限が残った) でも宙づりにしない
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);
    await pending;

    expect(leftTimers).toBe(0);
  });

  it('completes a request pending at dispose with a PoSW that verifies against its input', async () => {
    const manager = managerWith(makeSilentWorker());
    const pending = manager.computePoSW(previousHash, eventData);

    manager.dispose();
    await vi.advanceTimersByTimeAsync(WORKER_REQUEST_TIMEOUT_MS);

    expect(await verifyPoSW(previousHash, eventData, await pending)).toBe(true);
  });
});

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (PoswManagerDispose Test)',
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

describe('TypingProof.dispose with an event in flight (#735)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Worker が応答しない間に記録を投げ、PoSW 計算中に dispose する (閉じたタブの後始末と同じ順) */
  async function disposeWhileRecording(data: string[]) {
    const worker = makeSilentWorker();
    const proof = new TypingProof();
    await proof.initialize(await computeHash(JSON.stringify(components)), components, worker as unknown as Worker);
    const recording = Promise.all(
      data.map((d) => proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: d }))
    );
    // 最初の要求が Worker に出るまで進める
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());

    proof.dispose();
    return { proof, recording };
  }

  it('commits the in-flight events to the chain with their contents and order intact', async () => {
    const { proof, recording } = await disposeWhileRecording(['a', 'b']);
    const results = await recording;

    expect({
      recorded: results.map((r) => r.recorded),
      data: proof.events.map((e) => e.data),
      sequences: proof.events.map((e) => e.sequence),
    }).toEqual({ recorded: [true, true], data: ['a', 'b'], sequences: [0, 1] });
  }, 10_000);

  it('drains the record queue after dispose so the close-tab wait (#342) completes', async () => {
    const { proof } = await disposeWhileRecording(['a']);

    const drain = await proof.waitForQueueDrain({ stallTimeoutMs: 5_000, maxWaitMs: 8_000 });

    expect(drain.drained).toBe(true);
  }, 10_000);
});
