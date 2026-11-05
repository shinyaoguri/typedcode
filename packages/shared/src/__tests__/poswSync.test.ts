/**
 * PoSW 検証の同期 SHA-256 化 (#267) のパリティテスト
 *
 * 検証側の PoSW 反復は `iterateSha256HexSync` (@noble/hashes の同期 sha256) に置き換えた。
 * 記録側 (`PoswManager` / `poswWorker.ts`) は従来どおり `await crypto.subtle.digest` の
 * 反復なので、**両者の出力がビット単位で一致する**ことがこの変更の唯一の前提になる。
 *
 * 注意: vitest の `setup.ts` は `crypto.subtle.digest` を `node:crypto` に差し替えている。
 * `computeHash` との一致だけでは「差し替えた実装との一致」しか見えないので、`node:crypto` の
 * `createHash` で独立に計算した固定ベクタ (`fixtures/poswVectors.ts`。記録側の Worker も同じ表で縛る) も併用する。
 *
 * 速度は CI で assert しない (負荷で大きく揺れる)。計測は `BENCH_POSW=1` のときだけ走る
 * ベンチ (末尾) で行う:
 *   BENCH_POSW=1 npx vitest run poswSync -w @typedcode/shared
 */

import { describe, expect, it } from 'vitest';
import { POSW_ITERATIONS } from '../version.js';
import { computeHash, iterateSha256HexSync } from '../utils/hashUtils.js';
import { verifyPoSW } from '../verification.js';
import { HashChainManager } from '../typingProof/HashChainManager.js';
import { PoswManager } from '../typingProof/PoswManager.js';
import { POSW_FIXED_VECTORS } from './fixtures/poswVectors.js';

/** 記録側と同じ手順: seed を 1 回ハッシュし、以後 16 進文字列を n-1 回ハッシュし直す */
async function iterateComputeHash(seed: string, iterations: number): Promise<string> {
  let hash = await computeHash(seed);
  for (let i = 1; i < iterations; i++) {
    hash = await computeHash(hash);
  }
  return hash;
}

const SEEDS = ['typedcode-posw', 'タイピング証明', ''] as const;
const COUNTS = [1, 2, POSW_ITERATIONS] as const;

describe('iterateSha256HexSync', () => {
  const parityCases = SEEDS.flatMap((seed) => COUNTS.map((n) => [seed, n] as const));

  it.each(parityCases)('equals computeHash awaited n times (seed=%j, n=%i)', async (seed, n) => {
    expect(iterateSha256HexSync(seed, n)).toBe(await iterateComputeHash(seed, n));
  });

  it.each(POSW_FIXED_VECTORS)('matches the node:crypto fixed vector (seed=%j, n=%i)', (seed, n, expected) => {
    expect(iterateSha256HexSync(seed, n)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer iteration count (%s)', (n) => {
    expect(() => iterateSha256HexSync('seed', n)).toThrow(RangeError);
  });
});

describe('verifyPoSW with synchronous SHA-256', () => {
  const previousHash = 'a'.repeat(64);
  const eventDataString = '{"data":"x","sequence":1,"type":"contentChange"}';

  /** 記録側のメインスレッドフォールバック (Worker 未初期化) で実際の PoSW を焼く */
  const recordPoSW = () => new PoswManager(new HashChainManager()).computePoSW(previousHash, eventDataString);

  it('accepts a PoSW produced by the recording-side main-thread computation', async () => {
    const posw = await recordPoSW();
    expect(await verifyPoSW(previousHash, eventDataString, posw)).toBe(true);
  });

  it('rejects a PoSW whose nonce differs by one character', async () => {
    const posw = await recordPoSW();
    const flipped = posw.nonce.startsWith('0') ? `1${posw.nonce.slice(1)}` : `0${posw.nonce.slice(1)}`;
    expect(await verifyPoSW(previousHash, eventDataString, { ...posw, nonce: flipped })).toBe(false);
  });
});

/**
 * before/after 計測 (BENCH_POSW=1 のときだけ)。PR 本文に載せる ms/event を出す。
 * async 側は setup.ts の差し替え (node:crypto) を経由するので、実ブラウザ / 素の Node の
 * WebCrypto とは絶対値が異なる。素の Node での計測は vitest 外で行うこと。
 */
describe.runIf(process.env['BENCH_POSW'] === '1')('PoSW verification benchmark', () => {
  it('reports ms/event for async and sync iteration', async () => {
    const events = 5;
    const asyncStart = performance.now();
    for (let e = 0; e < events; e++) await iterateComputeHash(`bench-${e}`, POSW_ITERATIONS);
    const asyncMs = (performance.now() - asyncStart) / events;

    const syncStart = performance.now();
    for (let e = 0; e < events; e++) iterateSha256HexSync(`bench-${e}`, POSW_ITERATIONS);
    const syncMs = (performance.now() - syncStart) / events;

    console.log(
      `[posw-bench] async ${asyncMs.toFixed(1)} ms/event, sync ${syncMs.toFixed(1)} ms/event (${(asyncMs / syncMs).toFixed(1)}x)`
    );
    expect(syncMs).toBeGreaterThan(0);
  }, 120_000);
});
