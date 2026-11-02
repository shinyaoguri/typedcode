/**
 * TypingProof.dispose (#342) のテスト。
 *
 * 閉じたタブの PoSW Worker を終了する入口。`PoswManager.dispose` は以前から在ったが、
 * `TypingProof` が持つ `poswManager` は private で、呼び出し元が 0 件のまま Worker が漏れていた。
 */

import { describe, expect, it, vi } from 'vitest';
import { TypingProof, computeHash } from '../index.js';
import type { FingerprintComponents } from '../types.js';

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (TypingProofDispose Test)',
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

/** 呼ばれた回数だけ数える Worker のスタブ (PoSW の値そのものは関心外) */
function makeWorker() {
  return {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

async function initProof(worker: ReturnType<typeof makeWorker>): Promise<TypingProof> {
  const proof = new TypingProof();
  await proof.initialize(await computeHash(JSON.stringify(components)), components, worker as unknown as Worker);
  return proof;
}

describe('TypingProof.dispose (#342)', () => {
  it('terminates the PoSW worker', async () => {
    const worker = makeWorker();
    const proof = await initProof(worker);

    proof.dispose();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second dispose does not terminate again', async () => {
    const worker = makeWorker();
    const proof = await initProof(worker);

    proof.dispose();
    proof.dispose();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('does not terminate the worker before dispose is called', async () => {
    const worker = makeWorker();
    await initProof(worker);

    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('still records an event after dispose, through the main-thread fallback', async () => {
    const worker = makeWorker();
    const proof = await initProof(worker);
    proof.dispose();

    const result = await proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: 'a' });

    expect(result.recorded).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
