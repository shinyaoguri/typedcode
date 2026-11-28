/**
 * `expectConsistent` (tests/helpers/app.ts) の待ちの判定 (#892)。副作用の無い関数だけを置き、テストは
 * drain-wait.test.mjs (node --test) が持つ。
 *
 * 打鍵の直後はアクティブなタブの PoSW の処理待ち (pending) が残り、DOM の件数・ハッシュが snapshot に追いつかない。
 * 処理の速さはランナーの負荷で大きく変わる (CI で約 5 件/秒 = #783、ブラウザを 1 コアに絞ると約 1.3 件/秒 = #892)
 * ので、固定の上限では「遅いが減り続けている」と「止まっている」を区別できない (#892)。そこで、件数が進んでいる間は
 * 上限 (`capMs`) まで待ち、`stallMs` の間 1 件も進まなければ止まっているとみなして落とす。
 *
 * 進んだ = 直前の観測より確定件数 (committed = totalEvents) が増えたか、処理待ち (pending) が減った。
 */

/**
 * @typedef {{ atMs: number, pending: number | null, committed: number | null }} DrainSample
 *   `atMs` は待ち始めからの経過、`pending` / `committed` はアクティブなタブの処理待ちと確定件数
 *   (アクティブなタブが無ければ null)。
 * @typedef {'wait' | 'stalled' | 'cap'} DrainVerdict
 *   `wait` はまだ待つ、`stalled` は `stallMs` の間進まなかった、`cap` は進んでいても上限に達した。
 */

/**
 * 最後に進んだ時刻 (最初の観測は待ち始めなので進んだとみなす)。
 * @param {readonly DrainSample[]} samples
 * @returns {number}
 */
export function lastProgressAtMs(samples) {
  let at = samples[0]?.atMs ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const committedUp = cur.committed !== null && prev.committed !== null && cur.committed > prev.committed;
    const pendingDown = cur.pending !== null && prev.pending !== null && cur.pending < prev.pending;
    if (committedUp || pendingDown) at = cur.atMs;
  }
  return at;
}

/**
 * まだ待つか、どちらの理由で諦めるか。上限を先に見る (進み続けていても `capMs` で切る)。
 * @param {readonly DrainSample[]} samples 待ち始めからの観測 (古い順。1 件以上)
 * @param {{ stallMs: number, capMs: number }} limits
 * @returns {DrainVerdict}
 */
export function judgeDrain(samples, { stallMs, capMs }) {
  const last = samples.at(-1);
  if (!last) return 'wait';
  if (last.atMs >= capMs) return 'cap';
  if (last.atMs - lastProgressAtMs(samples) >= stallMs) return 'stalled';
  return 'wait';
}

/**
 * 処理待ちと確定件数の推移を、値が変わった観測だけ並べた 1 行にする (失敗の報告に添える)。
 * 長いときは先頭と末尾の `keep` 件ずつを残し、間を省いた件数を書く。
 * @param {readonly DrainSample[]} samples
 * @param {number} [keep]
 * @returns {string}
 */
export function formatDrainTrajectory(samples, keep = 15) {
  /** @type {DrainSample[]} */
  const changes = [];
  for (const s of samples) {
    const prev = changes.at(-1);
    if (!prev || prev.pending !== s.pending || prev.committed !== s.committed) changes.push(s);
  }
  const last = samples.at(-1);
  if (last && changes.at(-1) !== last) changes.push(last);
  const fmt = (s) => `${(s.atMs / 1000).toFixed(1)}s pending=${s.pending ?? '-'} committed=${s.committed ?? '-'}`;
  if (changes.length <= keep * 2) return changes.map(fmt).join(' → ');
  const omitted = changes.length - keep * 2;
  return [...changes.slice(0, keep).map(fmt), `(${omitted} more)`, ...changes.slice(-keep).map(fmt)].join(' → ');
}
