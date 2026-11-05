/**
 * system-spec §10 の時刻アンカー閾値の境界 (#580)。
 *
 * 密度 (ADR-0016: `maxGapEvents` / `maxUnexplainedGapServerMs` / `maxUnanchoredEventSpanMs` /
 * `firstAnchorLatencyEvents`) と post-hoc 疑い (イベント時刻のリード ≤ max(`POST_HOC_TOLERANCE_MS`,
 * `POST_HOC_TOLERANCE_RATIO` × Δs)。#320) が、閾値ちょうど・前後で判定を変えることを固定する。
 * 値は書き写さず signedCheckpoints.ts の定数を参照する (閾値を動かしてもテストは境界についてくる)。
 *
 * 密度と post-hoc は署名 cp が指す eventIndex と時刻 (イベント時刻・サーバ時刻) の間隔だけで決まり、
 * ハッシュチェーンの中身には依存しないので、イベント列は合成 (makeSyntheticEvents) を使う。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { verifySignedCheckpoints, type SignedCheckpointsVerificationResult, type StoredEvent } from '../index.js';
import {
  MAX_ANCHOR_GAP_EVENTS,
  MAX_ANCHOR_GAP_SERVER_MS,
  MAX_FIRST_ANCHOR_LATENCY_EVENTS,
  MAX_UNANCHORED_EVENT_SPAN_MS,
  POST_HOC_TOLERANCE_MS,
  POST_HOC_TOLERANCE_RATIO,
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
/**
 * イベント時刻 (event.timestamp) の起点。0 にすると、差 (e_j − e_k) を取るべきところで足す実装でも
 * 値が変わらず見逃すので、正の値から始める (#320)。
 */
const EVENT_ORIGIN_MS = 5_000;

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

type CheckpointLayout = Omit<BuildSignedCheckpointsOptions, 'events' | 'initialEventChainHash' | 'key'>;

/**
 * 合成イベント列に、指定の配置で署名 cp を打って検証する。既定の server 時刻は firstSeenAt の 1 秒後から 1 秒間隔。
 * `sessionAnchorIssuedAt` は post-hoc 照合の基点 (#320)。
 */
async function verifyLayout(
  events: StoredEvent[],
  layout: CheckpointLayout & { sessionAnchorIssuedAt?: string | null }
): Promise<SignedCheckpointsVerificationResult> {
  const { sessionAnchorIssuedAt, ...rest } = layout;
  const checkpoints = await buildSignedCheckpoints({
    events,
    initialEventChainHash: ROOT,
    key: testKey,
    firstSeenAt: new Date(FIRST_SEEN_MS).toISOString(),
    startServerMs: FIRST_SEEN_MS + 1000,
    ...rest,
  });
  return verifySignedCheckpoints(events, checkpoints, ROOT, {
    registry: [testKey.registryEntry],
    sessionAnchorIssuedAt,
  });
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
  ])(
    'treats a server-time gap of %i ms not explained by event time between two anchors as sparse=%s',
    async (gapMs, sparse) => {
      // 2 つのイベントは同じイベント時刻 (Δe = 0) なので、サーバ時刻の空白はまるごと説明できない (#320)。
      const result = await verifyLayout(
        makeSyntheticEvents(2, () => 0),
        { serverStepMs: gapMs }
      );
      expect(result.density!.sparse).toBe(sparse);
    }
  );

  it.each([
    [MAX_ANCHOR_GAP_SERVER_MS - 1, false],
    [MAX_ANCHOR_GAP_SERVER_MS, false],
    [MAX_ANCHOR_GAP_SERVER_MS + 1, true],
  ])(
    'treats an unexplained gap of %i ms left after subtracting the event-time gap as sparse=%s',
    async (unexplainedMs, sparse) => {
      // サーバ時刻の空白 5 分のうち、イベント時刻で説明できるのは (5 分 − unexplainedMs)。
      // イベント時刻は 0 からではなく EVENT_ORIGIN_MS から始める (差を取らずに足す実装を見逃さない)。
      const serverGapMs = 5 * 60_000;
      const result = await verifyLayout(
        makeSyntheticEvents(2, (i) => EVENT_ORIGIN_MS + i * (serverGapMs - unexplainedMs)),
        { serverStepMs: serverGapMs }
      );
      expect(result.density!.sparse).toBe(sparse);
    }
  );

  it.each([
    [MAX_UNANCHORED_EVENT_SPAN_MS - 1, false],
    [MAX_UNANCHORED_EVENT_SPAN_MS, false],
    [MAX_UNANCHORED_EVENT_SPAN_MS + 1, true],
  ])(
    'treats an unsigned event %i ms after the previous anchor (before the next one) as sparse=%s',
    async (spanMs, sparse) => {
      // cp は event 0 と 2。event 1 は署名で挟まれているが cp を持たない。サーバ時刻は Δe と同じだけ進む。
      const result = await verifyLayout(
        makeSyntheticEvents(3, (i) => EVENT_ORIGIN_MS + [0, spanMs, spanMs + 1][i]!),
        { eventIndexes: [0, 2], serverStepMs: spanMs + 1 }
      );
      expect(result.density!.sparse).toBe(sparse);
    }
  );

  it.each([
    [MAX_ANCHOR_GAP_SERVER_MS - 1, false],
    [MAX_ANCHOR_GAP_SERVER_MS, false],
    [MAX_ANCHOR_GAP_SERVER_MS + 1, true],
  ])('treats a first anchor signed %i ms after firstSeenAt as sparse=%s', async (latencyMs, sparse) => {
    const result = await verifyLayout(makeSyntheticEvents(1), { startServerMs: FIRST_SEEN_MS + latencyMs });
    expect(result.density!.sparse).toBe(sparse);
  });

  it('still measures the server-time gap between anchors when firstSeenAt is unparsable', async () => {
    const result = await verifyLayout(
      makeSyntheticEvents(2, () => 0),
      {
        firstSeenAt: 'not-a-date',
        serverStepMs: MAX_ANCHOR_GAP_SERVER_MS + 1,
      }
    );
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

describe('post-hoc batch signing tolerance (spec §10, #320)', () => {
  /** 2 つの署名 cp をサーバ時刻 serverDeltaMs 離して打ち、イベント時刻を leadMs だけ多く進める。 */
  const verifyLead = (serverDeltaMs: number, leadMs: number) =>
    verifyLayout(
      makeSyntheticEvents(2, (i) => EVENT_ORIGIN_MS + i * (serverDeltaMs + leadMs)),
      { serverStepMs: serverDeltaMs }
    );

  it.each([
    [POST_HOC_TOLERANCE_MS - 1, false],
    [POST_HOC_TOLERANCE_MS, false],
    [POST_HOC_TOLERANCE_MS + 1, true],
  ])('treats an event-time lead of %i ms over a one-second server span as post-hoc=%s', async (leadMs, postHoc) => {
    const result = await verifyLead(1000, leadMs);
    expect(result.temporal!.postHocSuspected).toBe(postHoc);
  });

  // 200 分のスパンでは相対の許容差 (1% = 120s) が絶対値 (60s) より大きい。
  const LONG_SPAN_MS = 200 * 60_000;
  const relativeTolerance = POST_HOC_TOLERANCE_RATIO * LONG_SPAN_MS;

  it.each([
    [relativeTolerance - 1000, false],
    [relativeTolerance, false],
    [relativeTolerance + 1, true],
    [relativeTolerance + 1000, true],
  ])('treats an event-time lead of %i ms over a 200-minute server span as post-hoc=%s', async (leadMs, postHoc) => {
    const result = await verifyLead(LONG_SPAN_MS, leadMs);
    expect(result.temporal!.postHocSuspected).toBe(postHoc);
  });

  it('applies the absolute tolerance when the base point issuedAt is later than the signature', async () => {
    // 基点の issuedAt が cp より後 (Δs < 0)。正直な proof では起きない形で、許容差は絶対値の 60s だけになる。
    const result = await verifyLayout(makeSyntheticEvents(1), {
      sessionAnchorIssuedAt: new Date(FIRST_SEEN_MS + 1000 + POST_HOC_TOLERANCE_MS + 1).toISOString(),
    });
    expect(result.temporal!.postHocSuspected).toBe(true);
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
