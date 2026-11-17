/**
 * PoSW Worker のファクトリ (#701)。
 *
 * TabManager は Worker を作ってから Turnstile などを待ち、その後で TypingProof に渡す。スクリプトの読み込みに
 * 失敗した Worker は生成直後に 1 度だけ `error` を出すので、故障の観測は生成と同じ同期区間で始まっていなければ
 * ならない (attach の時点で付く `onerror` では取り逃がす)。観測した故障の扱いは shared の
 * `poswManagerWorkerFailure.test.ts` が縛る。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPoswWorker } from '../createPoswWorker.js';

/** `error` リスナの登録だけを記録する Worker のスタブ */
class RecordingWorker {
  static last: RecordingWorker | null = null;
  readonly listenedTypes: string[] = [];
  onmessage = null;
  onerror = null;

  constructor() {
    RecordingWorker.last = this;
  }

  addEventListener(type: string): void {
    this.listenedTypes.push(type);
  }

  postMessage(): void {}
  terminate(): void {}
}

describe('createPoswWorker (#701)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    RecordingWorker.last = null;
  });

  it('starts observing worker errors before it returns the new worker', () => {
    vi.stubGlobal('Worker', RecordingWorker);

    const worker = createPoswWorker() as unknown as RecordingWorker;

    expect(worker.listenedTypes).toContain('error');
  });
});
