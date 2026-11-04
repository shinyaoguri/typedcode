/**
 * system-spec §10 の時刻アンカー閾値の境界 (#580)。
 *
 * 密度 (ADR-0016: `maxGapEvents` / `maxGapServerMs` / `firstAnchorLatencyEvents`) と post-hoc 疑い
 * (`ratio < POST_HOC_RATIO_THRESHOLD`) が、閾値ちょうど・前後で判定を変えることを固定する。
 * 値は書き写さず signedCheckpoints.ts の定数を参照する (閾値を動かしてもテストは境界についてくる)。
 *
 * 密度と post-hoc は署名 cp が指す eventIndex と時刻の間隔だけで決まり、ハッシュチェーンの中身には
 * 依存しないので、イベント列は合成 (makeSyntheticEvents) を使う。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { verifySignedCheckpoints, type SignedCheckpointsVerificationResult, type StoredEvent } from '../index.js';
import {
  MAX_ANCHOR_GAP_EVENTS,
  MAX_ANCHOR_GAP_SERVER_MS,
  MAX_FIRST_ANCHOR_LATENCY_EVENTS,
  POST_HOC_MIN_CLIENT_SPAN_MS,
  POST_HOC_MIN_SERVER_SPAN_MS,
  POST_HOC_RATIO_THRESHOLD,
} from '../signedCheckpoints.js';
import {
  buildSignedCheckpoints,
  createTestKey,
  makeSyntheticEvents,
  type BuildSignedCheckpointsOptions,
  type TestKey,
} from './fixtures/signedCheckpointFixtures.js';

const ROOT = 'a'.repeat(64);
const FIRST_SEEN_MS = Date.parse('2026-05-28T12:00:00.000Z');

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

type CheckpointLayout = Omit<BuildSignedCheckpointsOptions, 'events' | 'initialEventChainHash' | 'key'>;

/** 合成イベント列に、指定の配置で署名 cp を打って検証する。既定の server 時刻は firstSeenAt の 1 秒後から 1 秒間隔。 */
async function verifyLayout(
  events: StoredEvent[],
  layout: CheckpointLayout
): Promise<SignedCheckpointsVerificationResult> {
  const checkpoints = await buildSignedCheckpoints({
    events,
    initialEventChainHash: ROOT,
    key: testKey,
    firstSeenAt: new Date(FIRST_SEEN_MS).toISOString(),
    startServerMs: FIRST_SEEN_MS + 1000,
    ...layout,
  });
  return verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [testKey.registryEntry] });
}

describe('anchor density thresholds (ADR-0016, spec §10)', () => {
  it.each([
    [MAX_ANCHOR_GAP_EVENTS - 1, false],
    [MAX_ANCHOR_GAP_EVENTS, false],
    [MAX_ANCHOR_GAP_EVENTS + 1, true],
  ])('treats an event gap of %i between two consecutive anchors as sparse=%s', async (gap, sparse) => {
    // 先頭と末尾のギャップは 0。連続するアンカー間のギャップだけが閾値に触れる。
    const result = await verifyLayout(makeSyntheticEvents(gap + 1), { eventIndexes: [0, gap] });
    expect(result.density!.sparse).toBe(sparse);
  });

  it.each([
    [MAX_ANCHOR_GAP_EVENTS - 1, false],
    [MAX_ANCHOR_GAP_EVENTS, false],
    [MAX_ANCHOR_GAP_EVENTS + 1, true],
  ])('treats %i unsigned events after the last anchor as sparse=%s', async (tail, sparse) => {
    const result = await verifyLayout(makeSyntheticEvents(tail + 1), { eventIndexes: [0] });
    expect(result.density!.sparse).toBe(sparse);
  });

  it.each([
    [MAX_FIRST_ANCHOR_LATENCY_EVENTS - 1, false],
    [MAX_FIRST_ANCHOR_LATENCY_EVENTS, false],
    [MAX_FIRST_ANCHOR_LATENCY_EVENTS + 1, true],
  ])('treats a first anchor %i events into the session as sparse=%s', async (latency, sparse) => {
    // 唯一のアンカーを最終イベントに置き、末尾ギャップを 0 にする。
    const result = await verifyLayout(makeSyntheticEvents(latency + 1), { eventIndexes: [latency] });
    expect(result.density!.sparse).toBe(sparse);
  });

  it.each([
    [MAX_ANCHOR_GAP_SERVER_MS - 1, false],
    [MAX_ANCHOR_GAP_SERVER_MS, false],
    [MAX_ANCHOR_GAP_SERVER_MS + 1, true],
  ])('treats a server-time gap of %i ms between two consecutive anchors as sparse=%s', async (gapMs, sparse) => {
    const result = await verifyLayout(makeSyntheticEvents(2), { serverStepMs: gapMs });
    expect(result.density!.sparse).toBe(sparse);
  });

  it.each([
    [MAX_ANCHOR_GAP_SERVER_MS - 1, false],
    [MAX_ANCHOR_GAP_SERVER_MS, false],
    [MAX_ANCHOR_GAP_SERVER_MS + 1, true],
  ])('treats a first anchor signed %i ms after firstSeenAt as sparse=%s', async (latencyMs, sparse) => {
    const result = await verifyLayout(makeSyntheticEvents(1), { startServerMs: FIRST_SEEN_MS + latencyMs });
    expect(result.density!.sparse).toBe(sparse);
  });

  it('still measures the server-time gap between anchors when firstSeenAt is unparsable', async () => {
    const result = await verifyLayout(makeSyntheticEvents(2), {
      firstSeenAt: 'not-a-date',
      serverStepMs: MAX_ANCHOR_GAP_SERVER_MS + 1,
    });
    expect(result.density!.sparse).toBe(true);
  });

  it('reports the server time from firstSeenAt to the first anchor as the first-anchor latency', async () => {
    const result = await verifyLayout(makeSyntheticEvents(1), { startServerMs: FIRST_SEEN_MS + 7_000 });
    expect(result.density!.firstAnchorLatencyServerMs).toBe(7_000);
  });

  it('reports no first-anchor server latency when firstSeenAt is unparsable', async () => {
    const result = await verifyLayout(makeSyntheticEvents(1), { firstSeenAt: 'not-a-date' });
    expect(result.density!.firstAnchorLatencyServerMs).toBeNull();
  });
});

describe('post-hoc batch signing threshold (spec §10)', () => {
  const CLIENT_SPAN_MS = 1_000_000;
  const serverSpanAtThreshold = Math.round(POST_HOC_RATIO_THRESHOLD * CLIENT_SPAN_MS);

  it.each([
    [serverSpanAtThreshold - 1, true],
    [serverSpanAtThreshold, false],
    [serverSpanAtThreshold + 1, false],
  ])('treats a server span of %i ms over a 1,000,000 ms client span as post-hoc=%s', async (serverSpanMs, postHoc) => {
    const result = await verifyLayout(makeSyntheticEvents(2), {
      clientStepMs: CLIENT_SPAN_MS,
      serverStepMs: serverSpanMs,
    });
    expect(result.temporal!.postHocSuspected).toBe(postHoc);
  });

  it('flags a sub-minimum server span over a client span beyond the minimum as post-hoc', async () => {
    const result = await verifyLayout(makeSyntheticEvents(2), {
      clientStepMs: POST_HOC_MIN_CLIENT_SPAN_MS + 1,
      serverStepMs: POST_HOC_MIN_SERVER_SPAN_MS - 1,
    });
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('does not flag a client span beyond the minimum when the server span is not short', async () => {
    // ratio は閾値の 2 倍。長いクライアント時間だけでは post-hoc にしない。
    const result = await verifyLayout(makeSyntheticEvents(2), {
      clientStepMs: POST_HOC_MIN_CLIENT_SPAN_MS + 1,
      serverStepMs: 2 * POST_HOC_MIN_SERVER_SPAN_MS,
    });
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('does not flag post-hoc signing when every checkpoint shares one client timestamp', async () => {
    // client span 0 では ratio を定義しない (null)。null を 0 と読んで「比率が閾値未満」にしない。
    const result = await verifyLayout(makeSyntheticEvents(2), { clientStepMs: 0 });
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('reports a null ratio when the client span is zero', async () => {
    const result = await verifyLayout(makeSyntheticEvents(2), { clientStepMs: 0 });
    expect(result.temporal!.ratio).toBeNull();
  });

  it('reports the ratio as the server span divided by the client span', async () => {
    const result = await verifyLayout(makeSyntheticEvents(2), { clientStepMs: 60_000, serverStepMs: 30_000 });
    expect(result.temporal!.ratio).toBe(0.5);
  });
});
