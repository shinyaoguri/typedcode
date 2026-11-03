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
import { VerificationQueue } from '../VerificationQueue.js';
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
