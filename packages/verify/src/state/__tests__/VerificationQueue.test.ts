/**
 * VerificationQueue の per-item キャッシュの寿命 (#281 v7) と、待ち行列の振る舞い (#331)。
 *
 * 問題パッケージ (.tcexam) の manifest は per item で持つ。clear / terminate でキューを
 * 空にしたあとも残ると、再利用された id に前の manifest が束縛されてしまう。
 *
 * 待ち行列の振る舞いは `globalThis.Worker` を postMessage / terminate を記録するモックに差し替えて見る
 * (本物の検証は走らせない)。Worker の応答はテストが `respond` で手で返す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExamPackageManifest } from '@typedcode/shared';
import { MAX_CONSECUTIVE_WORKER_FAILURES, VerificationQueue } from '../VerificationQueue.js';
import type { ProofFile, VerificationResultData, WorkerRequestMessage, WorkerResponseMessage } from '../../types.js';

interface QueueInternals {
  manifestMap: Map<string, ExamPackageManifest>;
  modeMap: Map<string, string>;
  parsedDataMap: Map<string, ProofFile>;
}

function queueWithCachedItem(): { queue: VerificationQueue; internals: QueueInternals } {
  const queue = new VerificationQueue();
  const internals = queue as unknown as QueueInternals;
  internals.modeMap.set('a', 'full');
  internals.manifestMap.set('a', {} as ExamPackageManifest);
  return { queue, internals };
}

describe('VerificationQueue cache lifetime', () => {
  it('drops cached exam manifests when the queue is cleared', () => {
    const { queue, internals } = queueWithCachedItem();

    queue.clear();

    expect(internals.manifestMap.size).toBe(0);
  });

  it('drops cached exam manifests when the queue is terminated', () => {
    const { queue, internals } = queueWithCachedItem();

    queue.terminate();

    expect(internals.manifestMap.size).toBe(0);
  });
});

/** postMessage / terminate を記録する Worker のモック。作られた順に `workers` に並ぶ。 */
class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: { data: WorkerResponseMessage }) => void) | null = null;
  onerror: ((error: { message: string }) => void) | null = null;
  posted: WorkerRequestMessage[] = [];
  terminated = false;

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: WorkerRequestMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /**
   * Worker 自体の障害 (モジュールの読み込み失敗など) を起こす。この後この個体は何にも応答しない
   * (テストが `respond` を呼ばない限り)。
   */
  fail(message = 'Failed to fetch dynamically imported module'): void {
    this.onerror?.({ message });
  }

  /** この Worker から応答を返す (本物の Worker の onmessage と同じ形)。 */
  respond(message: WorkerResponseMessage): void {
    this.onmessage?.({ data: message });
  }
}

const RESULT = { valid: true } as VerificationResultData;

/** イベント数 `events` の proof を JSON にしたもの。 */
function proofJson(events: number): string {
  return JSON.stringify(proofOf(events));
}

function proofOf(events: number): ProofFile {
  return { proof: { events: Array.from({ length: events }, (_, i) => ({ sequence: i })) } } as unknown as ProofFile;
}

/** すべての Worker に送られた id を、送られた順に並べる。 */
function sentIds(): string[] {
  return MockWorker.instances.flatMap((w) => w.posted.map((m) => m.id));
}

function currentWorker(): MockWorker {
  const worker = MockWorker.instances.at(-1);
  if (!worker) throw new Error('no worker was created');
  return worker;
}

function setup() {
  const queue = new VerificationQueue();
  const internals = queue as unknown as QueueInternals;
  const onComplete = vi.fn();
  const onCancelled = vi.fn();
  const onProgress = vi.fn();
  const onError = vi.fn();
  queue.setOnComplete(onComplete);
  queue.setOnError(onError);
  queue.setOnCancelled(onCancelled);
  queue.setOnProgress(onProgress);
  queue.initialize();
  return { queue, internals, onComplete, onCancelled, onProgress, onError };
}

describe('VerificationQueue scheduling with a mocked worker', () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    MockWorker.instances = [];
    globalThis.Worker = MockWorker as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('sends waiting proofs to the worker in ascending order of event count', () => {
    const { queue } = setup();
    // 1 件目は空いている Worker へすぐ送られるので、先に 1 件を処理中にしてから 3 件を並べる。
    queue.enqueue({ id: 'busy', filename: 'busy', rawData: proofJson(1) });
    queue.enqueue({ id: 'e30', filename: 'e30', rawData: proofJson(30) });
    queue.enqueue({ id: 'e5', filename: 'e5', rawData: proofJson(5) });
    queue.enqueue({ id: 'e12', filename: 'e12', rawData: proofJson(12) });

    for (const id of ['busy', 'e5', 'e12']) currentWorker().respond({ type: 'result', id, result: RESULT });

    expect(sentIds()).toEqual(['busy', 'e5', 'e12', 'e30']);
  });

  it('terminates the worker when the processing item is cancelled and sends the next item to a new worker', () => {
    const { queue, onCancelled } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    const first = currentWorker();

    expect(queue.cancel('a')).toBe(true);

    expect(first.terminated).toBe(true);
    expect(onCancelled).toHaveBeenCalledWith('a');
    expect(currentWorker()).not.toBe(first);
    expect(currentWorker().posted.map((m) => m.id)).toEqual(['b']);
  });

  it('reports a cancelled waiting item without touching the worker that is processing another item', () => {
    const { queue, onCancelled, onError } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    const worker = currentWorker();

    queue.cancel('b');
    worker.respond({ type: 'result', id: 'a', result: RESULT });

    expect(onCancelled).toHaveBeenCalledWith('b');
    expect(onError).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
    expect(sentIds()).toEqual(['a']);
  });

  it('does nothing when cancelling an id that is neither waiting nor processing', () => {
    const { queue, onCancelled } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });

    expect(queue.cancel('unknown')).toBe(false);

    expect(onCancelled).not.toHaveBeenCalled();
    expect(currentWorker().terminated).toBe(false);
  });

  it('drops a removed waiting item silently: never sent to the worker, reported neither as cancelled nor as an error', () => {
    const { queue, internals, onCancelled, onError } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) }, 'fast');

    queue.remove('b');
    currentWorker().respond({ type: 'result', id: 'a', result: RESULT });

    expect(sentIds()).toEqual(['a']);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(internals.modeMap.has('b')).toBe(false);
  });

  it('releases the parsed proof once its result arrives', () => {
    const { queue, internals } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });

    currentWorker().respond({ type: 'result', id: 'a', result: RESULT });

    expect(internals.parsedDataMap.size).toBe(0);
  });

  it('reverifies a released proof with the exam manifest using the proof passed by the caller', () => {
    const { queue } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    currentWorker().respond({ type: 'result', id: 'a', result: RESULT });
    const manifest = { examId: 'exam-1' } as unknown as ExamPackageManifest;
    const proof = proofOf(3);

    queue.reverifyWithManifest('a', manifest, proof);

    const second = currentWorker().posted.at(-1);
    expect(second).toMatchObject({ id: 'a', manifest, proofData: proof });
  });

  it('requeues a cancelled item with the proof passed by the caller', () => {
    const { queue } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.cancel('a');
    const proof = proofOf(3);

    queue.requeue('a', proof);

    expect(currentWorker().posted).toEqual([expect.objectContaining({ id: 'a', proofData: proof })]);
  });

  it('ignores a late result for an id that is no longer processing', () => {
    const { queue, onComplete } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    queue.cancel('a');

    currentWorker().respond({ type: 'result', id: 'a', result: RESULT });

    expect(onComplete).not.toHaveBeenCalled();
    expect(queue.getCurrentProcessing()?.id).toBe('b');
  });

  it('ignores messages from a worker that was replaced after a cancel', () => {
    const { queue, onComplete, onProgress } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    const old = currentWorker();
    queue.cancel('a');
    queue.requeue('a', proofOf(3));

    old.respond({ type: 'progress', id: 'a', current: 1, total: 3, phase: 'chain' });
    old.respond({ type: 'result', id: 'a', result: RESULT });

    expect(onProgress).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('VerificationQueue recovery from worker failures (#700)', () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    MockWorker.instances = [];
    globalThis.Worker = MockWorker as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('fails the processing item once and sends the next item to a new worker instead of the broken one', () => {
    const { queue, onError, onComplete } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    const broken = currentWorker();

    broken.fail();
    currentWorker().respond({ type: 'result', id: 'b', result: RESULT });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('a', expect.stringContaining('Worker error'));
    expect(broken.terminated).toBe(true);
    expect(broken.posted.map((m) => m.id)).toEqual(['a']);
    expect(currentWorker()).not.toBe(broken);
    expect(onComplete).toHaveBeenCalledWith('b', RESULT);
  });

  it('does not reuse a worker that failed while idle for the next enqueued item', () => {
    const { queue } = setup();
    const broken = currentWorker();

    broken.fail();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });

    expect(broken.terminated).toBe(true);
    expect(broken.posted).toEqual([]);
    expect(currentWorker()).not.toBe(broken);
    expect(currentWorker().posted.map((m) => m.id)).toEqual(['a']);
  });

  it('ignores late messages from a worker that was replaced after a worker failure', () => {
    const { queue, onComplete, onProgress, onError } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    const broken = currentWorker();
    broken.fail();

    broken.respond({ type: 'progress', id: 'b', current: 1, total: 3, phase: 'chain' });
    broken.respond({ type: 'result', id: 'b', result: RESULT });
    broken.respond({ type: 'error', id: 'b', error: 'late' });

    expect(onProgress).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(queue.getCurrentProcessing()?.id).toBe('b');
  });

  it('stops creating workers after repeated failures and ends every remaining item with an explicit error', () => {
    const { queue, onError } = setup();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const id of ids) queue.enqueue({ id, filename: id, rawData: proofJson(3) });

    // 毎回、いま送られた Worker を壊す。上限が無ければ項目の数だけ Worker を作り直し続ける。
    for (let i = 0; i < 20 && queue.isCurrentlyProcessing(); i++) currentWorker().fail();

    expect(queue.isCurrentlyProcessing()).toBe(false);
    expect(queue.getQueueLength()).toBe(0);
    expect(MockWorker.instances).toHaveLength(MAX_CONSECUTIVE_WORKER_FAILURES);
    expect(MAX_CONSECUTIVE_WORKER_FAILURES).toBeLessThan(ids.length);
    expect(onError.mock.calls.map(([id]) => id).sort()).toEqual(ids);
  });

  it('gives an item enqueued after the failure limit a single new worker and fails it explicitly if that worker also fails', () => {
    const { queue, onError } = setup();
    for (let i = 0; i < MAX_CONSECUTIVE_WORKER_FAILURES; i++) {
      queue.enqueue({ id: `q${i}`, filename: `q${i}`, rawData: proofJson(3) });
    }
    for (let i = 0; i < 20 && queue.isCurrentlyProcessing(); i++) currentWorker().fail();
    const before = MockWorker.instances.length;

    queue.enqueue({ id: 'late', filename: 'late', rawData: proofJson(3) });
    queue.enqueue({ id: 'later', filename: 'later', rawData: proofJson(3) });
    currentWorker().fail();

    expect(MockWorker.instances).toHaveLength(before + 1);
    expect(queue.isCurrentlyProcessing()).toBe(false);
    expect(onError).toHaveBeenCalledWith('late', expect.any(String));
    expect(onError).toHaveBeenCalledWith('later', expect.any(String));
  });

  it('counts only consecutive failures: a worker that answers resets the failure limit', () => {
    const { queue, onComplete } = setup();
    const ids = Array.from({ length: MAX_CONSECUTIVE_WORKER_FAILURES * 3 }, (_, i) => `p${i}`);
    for (const id of ids) queue.enqueue({ id, filename: id, rawData: proofJson(3) });

    // 上限の 1 手前まで壊し、1 件答えさせ、また上限の 1 手前まで壊す。
    for (let i = 0; i < MAX_CONSECUTIVE_WORKER_FAILURES - 1; i++) currentWorker().fail();
    const answered = queue.getCurrentProcessing()?.id;
    currentWorker().respond({ type: 'result', id: answered ?? '', result: RESULT });
    for (let i = 0; i < MAX_CONSECUTIVE_WORKER_FAILURES - 1; i++) currentWorker().fail();

    expect(onComplete).toHaveBeenCalledWith(answered, RESULT);
    expect(queue.isCurrentlyProcessing()).toBe(true);
    expect(queue.getQueueLength()).toBeGreaterThan(0);
  });

  it('keeps the same worker and moves on to the next item when the worker reports a per-proof error', () => {
    const { queue, onError, onComplete } = setup();
    queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
    queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    const worker = currentWorker();

    worker.respond({ type: 'error', id: 'a', error: 'hash chain broken' });
    worker.respond({ type: 'result', id: 'b', result: RESULT });

    expect(onError).toHaveBeenCalledWith('a', 'hash chain broken');
    expect(worker.terminated).toBe(false);
    expect(MockWorker.instances).toEqual([worker]);
    expect(worker.posted.map((m) => m.id)).toEqual(['a', 'b']);
    expect(onComplete).toHaveBeenCalledWith('b', RESULT);
  });

  it('ends items with an error instead of throwing when the worker cannot even be constructed', () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error('SecurityError');
      }
    } as unknown as typeof Worker;
    const queue = new VerificationQueue();
    const onError = vi.fn();
    queue.setOnError(onError);

    expect(() => {
      queue.enqueue({ id: 'a', filename: 'a', rawData: proofJson(3) });
      queue.enqueue({ id: 'b', filename: 'b', rawData: proofJson(3) });
    }).not.toThrow();

    expect(queue.isCurrentlyProcessing()).toBe(false);
    expect(onError).toHaveBeenCalledWith('a', expect.stringContaining('SecurityError'));
    expect(onError).toHaveBeenCalledWith('b', expect.any(String));
  });
});
