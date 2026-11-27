/**
 * drain-wait.mjs のテスト (#892)。`expectConsistent` の待ちが「遅いが進んでいる」処理待ちを待ち続け、
 * 「止まっている」処理待ちを上限より前に落とすことを、観測の列だけで確かめる。
 *
 * 実行: `node --test packages/e2e/scripts/drain-wait.test.mjs` (CI は deploy.yml の check job が回す)。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDrainTrajectory, judgeDrain } from './drain-wait.mjs';

const LIMITS = { stallMs: 20_000, capMs: 120_000 };

/** 0 秒から `everyMs` ごとに 1 件ずつ確定して処理待ちが減る観測 (`untilMs` まで)。 */
function draining(startPending, everyMs, untilMs) {
  const samples = [];
  for (let t = 0, done = 0; t <= untilMs; t += 500) {
    while ((done + 1) * everyMs <= t && done < startPending) done++;
    samples.push({ atMs: t, pending: startPending - done, committed: 2 + done });
  }
  return samples;
}

test('a queue that keeps draining slowly is still waited on long after the stall window', () => {
  // 2.5 秒に 1 件 (#892 の nightly の約 0.5 件/秒より遅い)。60 秒の時点でまだ残っている。
  const samples = draining(37, 2_500, 60_000);
  assert.ok(samples.at(-1).pending > 0);
  assert.equal(judgeDrain(samples, LIMITS), 'wait');
});

test('a queue that keeps draining is cut at the cap', () => {
  const samples = draining(1_000, 2_500, 120_000);
  assert.equal(judgeDrain(samples, LIMITS), 'cap');
});

test('a pending count that stops moving is reported as stalled once the stall window has passed', () => {
  // 9 秒で 1 件まで減り (最後に進んだのは 9 秒)、そこから動かない (Worker の応答が失われたときの形)。
  const samples = [
    ...draining(37, 250, 9_000),
    ...Array.from({ length: 50 }, (_, i) => ({ atMs: 9_500 + i * 500, pending: 1, committed: 38 })),
  ];
  const lastProgress = samples.find((s) => s.atMs === 9_000);
  assert.deepEqual(lastProgress, { atMs: 9_000, pending: 1, committed: 38 });
  const stallEndsAt = 9_000 + LIMITS.stallMs;
  const justBefore = samples.filter((s) => s.atMs < stallEndsAt);
  const atStallEnd = samples.filter((s) => s.atMs <= stallEndsAt);
  assert.equal(judgeDrain(justBefore, LIMITS), 'wait');
  assert.equal(judgeDrain(atStallEnd, LIMITS), 'stalled');
});

test('committed events growing count as progress even while the pending count does not shrink', () => {
  // 確定と同じ速さで新しいイベントが積まれ、pending は 3 のまま、committed だけが増える。
  const samples = Array.from({ length: 81 }, (_, i) => ({ atMs: i * 500, pending: 3, committed: 10 + i }));
  assert.equal(judgeDrain(samples, LIMITS), 'wait');
});

test('the trajectory lists only the observations whose values changed, plus the last one', () => {
  const samples = [
    { atMs: 0, pending: 3, committed: 1 },
    { atMs: 100, pending: 3, committed: 1 },
    { atMs: 600, pending: 2, committed: 2 },
    { atMs: 1100, pending: 2, committed: 2 },
  ];
  assert.equal(
    formatDrainTrajectory(samples),
    '0.0s pending=3 committed=1 → 0.6s pending=2 committed=2 → 1.1s pending=2 committed=2'
  );
});

test('a long trajectory keeps both ends and says how many changes it left out', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ atMs: i * 1000, pending: 10 - i, committed: i }));
  assert.equal(
    formatDrainTrajectory(samples, 2),
    '0.0s pending=10 committed=0 → 1.0s pending=9 committed=1 → (6 more) → 8.0s pending=2 committed=8 → 9.0s pending=1 committed=9'
  );
});
