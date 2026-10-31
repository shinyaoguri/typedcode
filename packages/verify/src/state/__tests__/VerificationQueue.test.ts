/**
 * VerificationQueue の per-item キャッシュの寿命 (#281 v7)。
 *
 * 問題パッケージ (.tcexam) の manifest は per item で持つ。clear / terminate でキューを
 * 空にしたあとも残ると、再利用された id に前の manifest が束縛されてしまう。
 * Worker を起動せず (initialize は呼ばない)、内部マップを直接触って寿命だけ見る。
 */

import { describe, expect, it } from 'vitest';
import type { ExamPackageManifest } from '@typedcode/shared';
import { VerificationQueue } from '../VerificationQueue.js';

interface QueueInternals {
  manifestMap: Map<string, ExamPackageManifest>;
  modeMap: Map<string, string>;
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
