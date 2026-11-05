/**
 * 署名 cp のイベント時刻 × サーバ時刻の照合 (#320)。
 *
 * post-hoc (事後一括署名) は、ハッシュで束縛されたイベント時刻 (`event.timestamp`、単調時計の相対 ms) の進みが
 * サーバ時刻 (`serverTimestamp`) の進みを許容差より多く超えたかで測る。申告値の `clientTimestamp` は判定に
 * 使わない (クライアントが好きに書ける)。照合は隣接ペアごとではなく任意の 2 点で行い、root が検証済みなら
 * token の `issuedAt` を基点に含める。
 *
 * 密度の「疎」は、サーバ時刻の空白のうちイベント時刻で説明できない分 (A) と、署名で挟まれていないイベントの
 * 時刻の幅 (B) で測る。正直な無操作 (Δe ≈ Δs) は疎にしない。
 *
 * イベント列は合成 (makeSyntheticEvents) を使う。合成列の hash は時刻に依存しないので、イベント時刻を自由に置ける。
 * 閾値の境界そのものは `signedCheckpointThresholds.test.ts` が見る。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAssurance,
  verifySignedCheckpoints,
  type SignedCheckpointsVerificationResult,
  type StoredEvent,
} from '../index.js';
import {
  buildSignedCheckpoints,
  createTestKey,
  makeSyntheticEvents,
  resignCheckpoints,
  type BuildSignedCheckpointsOptions,
  type TestKey,
} from './fixtures/signedCheckpointFixtures.js';

const ROOT = 'a'.repeat(64);
const T0 = Date.parse('2026-05-28T12:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

type CheckpointLayout = Omit<BuildSignedCheckpointsOptions, 'events' | 'initialEventChainHash' | 'key'>;

/**
 * 合成イベント列に署名 cp を打って検証する。clientTimestamp は既定で serverTimestamp の 120ms 前
 * (editor が enqueue したときの実時刻を正しく名乗る形)。post-hoc の判定がこれに頼らないことを見るため。
 */
async function verifyLayout(
  events: StoredEvent[],
  layout: CheckpointLayout & { sessionAnchorIssuedAt?: string | null }
): Promise<SignedCheckpointsVerificationResult> {
  const { sessionAnchorIssuedAt, ...rest } = layout;
  const serverMsAt = rest.serverMsAt ?? ((i: number) => T0 + (i + 1) * SEC);
  const checkpoints = await buildSignedCheckpoints({
    events,
    initialEventChainHash: ROOT,
    key: testKey,
    firstSeenAt: new Date(serverMsAt(0)).toISOString(),
    clientMsAt: (i) => serverMsAt(i) - 120,
    ...rest,
    serverMsAt,
  });
  return verifySignedCheckpoints(events, checkpoints, ROOT, {
    registry: [testKey.registryEntry],
    sessionAnchorIssuedAt,
  });
}

/** root アンカー済み・最終イベントまで署名済みの前提で、この結果の temporal を導出する。 */
function temporalOf(result: SignedCheckpointsVerificationResult) {
  return deriveAssurance({
    metadataValid: true,
    chainValid: true,
    rootAnchored: true,
    signedCheckpoints: {
      anchored: result.anchored,
      valid: result.valid,
      sparse: result.density?.sparse,
      postHocSuspected: result.temporal?.postHocSuspected,
      terminal: result.coverage.terminalAnchored,
    },
    sessionTokenMismatch: false,
    poswSkipped: false,
    isPureTyping: true,
  }).temporal;
}

describe('post-hoc batch signing measured on hashed event time (#320)', () => {
  // イベント時刻は 30 分に散っているが、署名はすべて 1 分以内。clientTimestamp は署名時刻を正しく名乗る。
  const batchSigned = () =>
    verifyLayout(
      makeSyntheticEvents(4, (i) => i * 10 * MIN),
      { serverMsAt: (i) => T0 + 30 * MIN + i * 19 * SEC }
    );

  it('flags post-hoc signing when event time spans 30 minutes but every signature falls within one minute', async () => {
    const result = await batchSigned();
    expect(result.valid).toBe(true);
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('derives a partial (not anchored) temporal level for a batch-signed session', async () => {
    expect(temporalOf(await batchSigned())).toBe('partial');
  });

  it('flags post-hoc signing that advances event time 50s per one-second signature (cumulative, not per pair)', async () => {
    // 隣接ペアごとのリードは 49s (許容差 60s 以内) だが、累積すると許容差を超える。
    const result = await verifyLayout(
      makeSyntheticEvents(10, (i) => i * 50 * SEC),
      {
        serverMsAt: (i) => T0 + i * SEC,
      }
    );
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('checks every pair of anchors, not only the one with the smallest event lead', async () => {
    // cp0 (s=0, lead 0) と cp2 (s=201 分, lead 115s) の組は 1% の許容差 (120.6s) に収まる。
    // cp1 (s=200 分, lead 50s) と cp2 の組は 1 分で 65s 進んでおり、絶対値の許容差 60s を超える。
    const serverOffsets = [0, 200 * MIN, 201 * MIN];
    const leads = [0, 50 * SEC, 115 * SEC];
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => serverOffsets[i]! + leads[i]!),
      { serverMsAt: (i) => T0 + serverOffsets[i]! }
    );
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('does not flag a session whose event time never runs ahead of server time', async () => {
    // 正直な形: イベント時刻の進みはサーバ時刻の進みより少し遅い (署名の往復ぶん)。
    const result = await verifyLayout(
      makeSyntheticEvents(5, (i) => i * 10 * SEC),
      {
        serverMsAt: (i) => T0 + i * 10 * SEC + 300,
      }
    );
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('does not use the self-reported client timestamps to flag post-hoc signing', async () => {
    // clientTimestamp だけが 1 時間に散っている。イベント時刻とサーバ時刻は一致しているので疑わない。
    const result = await verifyLayout(
      makeSyntheticEvents(4, (i) => i * SEC),
      {
        serverMsAt: (i) => T0 + i * SEC,
        clientMsAt: (i) => T0 + i * 20 * MIN,
      }
    );
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('reports the largest event lead over server time across all anchor pairs', async () => {
    // cp0 → cp1: Δe=40s, Δs=10s で lead 30s。cp1 → cp2 は遅れ側。全ペアの最大は 30s (cp0 → cp2 は 25s)。
    const eventTimes = [0, 40 * SEC, 45 * SEC];
    const serverOffsets = [0, 10 * SEC, 20 * SEC];
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => eventTimes[i]!),
      { serverMsAt: (i) => T0 + serverOffsets[i]! }
    );
    expect(result.temporal!.maxEventLeadMs).toBe(30 * SEC);
  });

  it('reports a zero event lead when event time always lags server time', async () => {
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => i * SEC),
      {
        serverMsAt: (i) => T0 + i * 2 * SEC,
      }
    );
    expect(result.temporal!.maxEventLeadMs).toBe(0);
  });

  it('reports the event-time span from the first to the last signed checkpoint', async () => {
    const result = await verifyLayout(
      makeSyntheticEvents(5, (i) => 1000 + i * 7 * SEC),
      {
        eventIndexes: [1, 3],
        serverMsAt: (i) => T0 + i * 20 * SEC,
      }
    );
    expect(result.temporal!.eventSpanMs).toBe(14 * SEC);
  });

  it('measures the event-time span only over anchors whose event time is a finite number', async () => {
    const events = makeSyntheticEvents(3, (i) => 1000 + i * 4 * SEC);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      serverMsAt: (i) => T0 + i * 10 * SEC,
    });
    (events[2] as { timestamp: unknown }).timestamp = null;
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [testKey.registryEntry] });
    expect(result.temporal!.eventSpanMs).toBe(4 * SEC);
  });

  it('reports a zero event-time span when no signed checkpoint has a finite event time', async () => {
    const events = makeSyntheticEvents(1);
    const checkpoints = await buildSignedCheckpoints({ events, initialEventChainHash: ROOT, key: testKey });
    (events[0] as { timestamp: unknown }).timestamp = null;
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [testKey.registryEntry] });
    expect(result.temporal!.eventSpanMs).toBe(0);
  });

  it('treats an anchor whose event time is not a finite number as post-hoc (fail-closed)', async () => {
    const events = makeSyntheticEvents(3, (i) => i * SEC);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      serverMsAt: (i) => T0 + i * SEC,
    });
    (events[1] as { timestamp: unknown }).timestamp = null;
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
      sessionAnchorIssuedAt: null,
    });
    expect(result.temporal!.postHocSuspected).toBe(true);
  });
});

describe('post-hoc base point at the verified session start token (#320)', () => {
  // 唯一の署名 cp は最終イベント (event 時刻 10 分) を指し、token の発行から 30 秒後に署名された。
  const singleLateAnchor = (sessionAnchorIssuedAt: string | null) =>
    verifyLayout(
      makeSyntheticEvents(2, (i) => i * 10 * MIN),
      { eventIndexes: [1], serverMsAt: () => T0 + 30 * SEC, sessionAnchorIssuedAt }
    );

  it('flags post-hoc signing from the token issuedAt even when the proof has a single signed checkpoint', async () => {
    const result = await singleLateAnchor(new Date(T0).toISOString());
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('does not use a base point when no verified issuedAt is passed', async () => {
    const result = await singleLateAnchor(null);
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('ignores an unparsable issuedAt instead of measuring from it', async () => {
    const result = await singleLateAnchor('not-a-date');
    expect(result.temporal!.postHocSuspected).toBe(false);
  });

  it('measures the base point from the first event, not from the first signed checkpoint', async () => {
    // event 0 (時刻 0) は token 発行の直後。cp は event 2 (時刻 70s) だけで、発行から 9s 後に署名された。
    // event 0 から数えるとイベント時刻 70s に対しサーバ時刻 9s で lead 61s。基点のイベント時刻を最初の cp の
    // イベント (時刻 70s) に取ると lead は出ない。
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => [0, 69 * SEC, 70 * SEC][i]!),
      { eventIndexes: [2], serverMsAt: () => T0 + 9 * SEC, sessionAnchorIssuedAt: new Date(T0).toISOString() }
    );
    expect(result.temporal!.postHocSuspected).toBe(true);
  });

  it('includes the base point in the reported largest event lead', async () => {
    const result = await singleLateAnchor(new Date(T0).toISOString());
    expect(result.temporal!.maxEventLeadMs).toBe(10 * MIN - 30 * SEC);
  });
});

describe('anchor density measured on unexplained server time (#320)', () => {
  it('does not flag a long idle pause whose server gap is explained by event time', async () => {
    // 考え込んで 5 分止まった。cp 間のサーバ時刻 5 分 ≈ イベント時刻 5 分。
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => i * 5 * MIN),
      {
        serverMsAt: (i) => T0 + i * 5 * MIN + 400,
      }
    );
    expect(result.density!.sparse).toBe(false);
  });

  it('derives an anchored temporal level for an honest session with a long idle pause', async () => {
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => i * 5 * MIN),
      {
        serverMsAt: (i) => T0 + i * 5 * MIN + 400,
      }
    );
    expect(temporalOf(result)).toBe('anchored');
  });

  it('still reports the raw server gap between anchors for display', async () => {
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => i * 5 * MIN),
      {
        serverMsAt: (i) => T0 + i * 5 * MIN,
      }
    );
    expect(result.density!.maxGapServerMs).toBe(5 * MIN);
  });

  it('reports the server gap not explained by event time between consecutive anchors', async () => {
    // cp0 → cp1: Δs=70s, Δe=30s で説明できない空白 40s。cp1 → cp2: Δs=10s, Δe=10s で 0。
    const eventTimes = [0, 30 * SEC, 40 * SEC];
    const serverOffsets = [0, 70 * SEC, 80 * SEC];
    const result = await verifyLayout(
      makeSyntheticEvents(3, (i) => eventTimes[i]!),
      { serverMsAt: (i) => T0 + serverOffsets[i]! }
    );
    expect(result.density!.maxUnexplainedGapServerMs).toBe(40 * SEC);
  });

  it('flags 300 events spread over five minutes between two signed checkpoints as sparse', async () => {
    // 5 分待ってオフラインで合成した 300 件を 5 分に散らし、先頭と末尾だけ署名させた形。
    // Δe ≈ Δs なので (A) は通り、件数 300 < 500 で件数ギャップも通る。
    const result = await verifyLayout(
      makeSyntheticEvents(300, (i) => i * SEC),
      {
        eventIndexes: [0, 299],
        serverMsAt: (i) => T0 + i * 299 * SEC + 200,
      }
    );
    expect(result.density!.sparse).toBe(true);
  });

  it('reports the longest event-time span not closed by the next signed checkpoint', async () => {
    // cp 0 と cp 4 の間のイベント 1..3 (時刻 10s, 20s, 35s)。未アンカーの幅は 35s。
    const result = await verifyLayout(
      makeSyntheticEvents(5, (i) => [0, 10, 20, 35, 40][i]! * SEC),
      {
        eventIndexes: [0, 4],
        serverMsAt: (i) => T0 + i * 40 * SEC + 200,
      }
    );
    expect(result.density!.maxUnanchoredEventSpanMs).toBe(35 * SEC);
  });

  it('does not count events before the first signed checkpoint as unanchored event time', async () => {
    // 先頭 3 件は最初の cp より前 (時刻トリガは最初の cp の後にしか効かない)。
    const result = await verifyLayout(
      makeSyntheticEvents(5, (i) => [0, 60, 120, 121, 122][i]! * SEC),
      {
        eventIndexes: [3, 4],
        serverMsAt: (i) => T0 + i * SEC + 200,
      }
    );
    expect(result.density!.maxUnanchoredEventSpanMs).toBe(0);
  });

  it('does not count events after the last signed checkpoint as unanchored event time', async () => {
    // 末尾は terminalAnchored (#295) が見る。
    const result = await verifyLayout(
      makeSyntheticEvents(5, (i) => [0, 1, 60, 120, 180][i]! * SEC),
      {
        eventIndexes: [0, 1],
        serverMsAt: (i) => T0 + i * SEC + 200,
      }
    );
    expect(result.density!.maxUnanchoredEventSpanMs).toBe(0);
  });

  it('treats a signed checkpoint whose event time is not a finite number as sparse (fail-closed)', async () => {
    const events = makeSyntheticEvents(2, (i) => i * SEC);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      serverMsAt: (i) => T0 + i * SEC + 200,
    });
    (events[1] as { timestamp: unknown }).timestamp = null;
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [testKey.registryEntry] });
    expect(result.density!.sparse).toBe(true);
  });

  it('keeps the density metrics finite when a signed checkpoint has an unparsable serverTimestamp', async () => {
    // 検証は失敗する (valid=false) が、失敗の経路でも計量に NaN を出さない。
    const events = makeSyntheticEvents(3, (i) => i * SEC);
    const checkpoints = await resignCheckpoints(
      await buildSignedCheckpoints({ events, initialEventChainHash: ROOT, key: testKey }),
      testKey,
      (payload, i) => (i === 1 ? { ...payload, serverTimestamp: 'not-a-date' } : payload)
    );
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [testKey.registryEntry] });
    expect(result.valid).toBe(false);
    expect(Number.isFinite(result.density!.maxUnexplainedGapServerMs)).toBe(true);
    expect(Number.isFinite(result.density!.maxGapServerMs)).toBe(true);
  });

  it('treats an event between anchors whose time is not a finite number as sparse (fail-closed)', async () => {
    const events = makeSyntheticEvents(3, (i) => i * SEC);
    const checkpoints = await buildSignedCheckpoints({
      events,
      initialEventChainHash: ROOT,
      key: testKey,
      eventIndexes: [0, 2],
      serverMsAt: (i) => T0 + i * 2 * SEC + 200,
    });
    (events[1] as { timestamp: unknown }).timestamp = 'soon';
    const result = await verifySignedCheckpoints(events, checkpoints, ROOT, {
      registry: [testKey.registryEntry],
      sessionAnchorIssuedAt: null,
    });
    expect(result.density!.sparse).toBe(true);
  });
});
