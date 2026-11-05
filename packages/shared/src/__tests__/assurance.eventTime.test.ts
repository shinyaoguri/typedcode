/**
 * イベント時刻 × サーバ時刻の照合 (#320) を、proof の生成から `verifyProofFile` → `deriveAssurance` まで通して固定する。
 *
 * イベント時刻 (`event.timestamp`) は TypingProof の `startTime` をずらして置く (timestamp = performance.now() −
 * startTime なので、startTime を X 戻すと以降のイベント時刻が X 進む)。ハッシュチェーンは本物のまま。
 * 署名 cp は fixture で好きなサーバ時刻に打つ。clientTimestamp は署名時刻の 120ms 前を正しく名乗る。
 *
 * 写像 (`FullVerificationResult` → `AssuranceInput`) は verify-cli の `verify.ts` と同じ形 (`assurance.unsignedTail.test.ts`
 * と同じ)。MockWorker が PoSW を偽データで返すので `mode: 'fast'` で呼ぶ。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  createSessionStartToken,
  deriveAssurance,
  verifyProofFile,
  type AssuranceInput,
  type FingerprintComponents,
  type FullVerificationResult,
} from '../index.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Event Time Test)',
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
});

const SERVER_NONCE = 'b2'.repeat(32); // 64-hex
const SESSION_ID = 'session-event-time';
const ISSUED_AT_MS = Date.parse('2026-05-28T12:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

interface ProofLayout {
  /** i 番目のイベントの直前に進めるイベント時刻 (ms)。長さがイベント数 */
  gapsBeforeEventMs: number[];
  /** 署名 cp を打つ eventIndex (省略時は全イベント) */
  signedEventIndexes?: number[];
  /** i 番目の署名 cp の serverTimestamp (token の issuedAt からの ms) */
  serverOffsetMs: (i: number) => number;
}

/** root アンカー済み (token は testKey で署名) の proof を、指定のイベント時刻と署名時刻で作る。 */
async function buildAnchoredProof(layout: ProofLayout) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await createSessionStartToken(
    { sessionId: SESSION_ID, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: new Date(ISSUED_AT_MS).toISOString(),
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: testKey.keyId, privateKey: testKey.privateKey }
  );

  const typingProof = new TypingProof();
  await typingProof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  let content = '';
  for (let i = 0; i < layout.gapsBeforeEventMs.length; i++) {
    typingProof.startTime -= layout.gapsBeforeEventMs[i]!;
    const ch = String.fromCharCode('a'.charCodeAt(0) + i);
    await typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await typingProof.exportProof(content);
  const checkpoints = await buildSignedCheckpoints({
    events: exported.proof.events,
    initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
    key: testKey,
    sessionId: SESSION_ID,
    eventIndexes: layout.signedEventIndexes,
    firstSeenAt: new Date(ISSUED_AT_MS + layout.serverOffsetMs(0)).toISOString(),
    serverMsAt: (i) => ISSUED_AT_MS + layout.serverOffsetMs(i),
    clientMsAt: (i) => ISSUED_AT_MS + layout.serverOffsetMs(i) - 120,
  });
  return { ...exported, checkpoints, content, language: 'text' };
}

type AnchoredProof = Awaited<ReturnType<typeof buildAnchoredProof>>;

const verify = (proofFile: AnchoredProof) =>
  verifyProofFile(proofFile, undefined, {
    mode: 'fast',
    signedCheckpointKeyRegistry: [testKey.registryEntry],
  });

/** verify-cli `verify.ts` の `deriveAssurance` 呼び出しと同じ写像 (分析・スクショは時刻層に効かないので省く)。 */
function temporalOf(result: FullVerificationResult) {
  const input: AssuranceInput = {
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    rootAnchored: result.rootAnchored ?? false,
    signedCheckpoints: result.signedCheckpoints
      ? {
          anchored: result.signedCheckpoints.anchored,
          valid: result.signedCheckpoints.valid,
          sparse: result.signedCheckpoints.density?.sparse,
          postHocSuspected: result.signedCheckpoints.temporal?.postHocSuspected,
          terminal: result.signedCheckpoints.coverage.terminalAnchored,
        }
      : undefined,
    sessionTokenMismatch: result.sessionTokenMismatch ?? false,
    isPureTyping: result.isPureTyping,
    poswSkipped: result.poswSkipped ?? false,
  };
  return deriveAssurance(input).temporal;
}

/** イベント 30 分・署名はすべて 1 分以内 (事後一括署名の形)。 */
const BATCH_SIGNED: ProofLayout = {
  gapsBeforeEventMs: [SEC, 10 * MIN, 10 * MIN, 10 * MIN],
  serverOffsetMs: (i) => 30 * MIN + 10 * SEC + i * 15 * SEC,
};

/** 打鍵の合間に 5 分ずつ考え込んだ正直なセッション。各イベントの 1 秒後に署名された。 */
const LONG_IDLE: ProofLayout = {
  gapsBeforeEventMs: [SEC, 5 * MIN, 5 * MIN],
  serverOffsetMs: (i) => 2 * SEC + i * 5 * MIN,
};

/** 3 分おきに打ったが通信が切れていて、6 分後に復帰してから 3 つの cp がまとめて署名された正直なセッション。 */
const SIGNED_AFTER_OUTAGE: ProofLayout = {
  gapsBeforeEventMs: [SEC, 3 * MIN, 3 * MIN],
  serverOffsetMs: (i) => 6 * MIN + 5 * SEC + i * SEC,
};

/** 署名 cp は最終イベント (開始から 10 分) の 1 個だけで、token 発行から 30 秒後に署名された。 */
const SINGLE_LATE_ANCHOR: ProofLayout = {
  gapsBeforeEventMs: [SEC, 10 * MIN],
  signedEventIndexes: [1],
  serverOffsetMs: () => 30 * SEC,
};

describe('temporal assurance from event time against server time (#320)', () => {
  it('derives partial for a batch-signed session even when client timestamps match the signing time', async () => {
    const result = await verify(await buildAnchoredProof(BATCH_SIGNED));
    expect(result.rootAnchored).toBe(true);
    expect(temporalOf(result)).toBe('partial');
  });

  it('derives anchored for an honest session with five-minute idle pauses between checkpoints', async () => {
    const result = await verify(await buildAnchoredProof(LONG_IDLE));
    expect(result.signedCheckpoints?.density?.sparse).toBe(false);
    expect(temporalOf(result)).toBe('anchored');
  });

  it('derives partial for an honest session whose checkpoints were signed together after a network outage', async () => {
    const result = await verify(await buildAnchoredProof(SIGNED_AFTER_OUTAGE));
    expect(temporalOf(result)).toBe('partial');
  });

  it('keeps integrity valid and the content readable for a session signed together after a network outage', async () => {
    const proofFile = await buildAnchoredProof(SIGNED_AFTER_OUTAGE);
    const result = await verify(proofFile);
    expect(result.integrityValid).toBe(true);
    expect(result.contentValid).toBe(true);
    expect(proofFile.content).toBe('abc');
  });

  it('flags post-hoc signing from the verified token issuedAt when the only signed checkpoint is late', async () => {
    const result = await verify(await buildAnchoredProof(SINGLE_LATE_ANCHOR));
    expect(result.rootAnchored).toBe(true);
    expect(result.signedCheckpoints?.temporal?.postHocSuspected).toBe(true);
  });

  it('does not measure from the issuedAt of a token that fails verification', async () => {
    const proofFile = await buildAnchoredProof(SINGLE_LATE_ANCHOR);
    const token = proofFile.sessionStartToken!;
    // 署名し直さずに issuedAt を書き換えた token は検証に落ち、root はアンカーされない (#329)。
    proofFile.sessionStartToken = { ...token, payload: { ...token.payload, issuedAt: '2026-05-28T12:00:00.001Z' } };
    const result = await verify(proofFile);
    expect(result.rootAnchored).toBe(false);
    expect(result.signedCheckpoints?.temporal?.postHocSuspected).toBe(false);
  });

  it('does not loosen the post-hoc check when an unverified token claims an earlier issuedAt', async () => {
    const proofFile = await buildAnchoredProof(BATCH_SIGNED);
    const token = proofFile.sessionStartToken!;
    proofFile.sessionStartToken = { ...token, payload: { ...token.payload, issuedAt: '2026-05-27T00:00:00.000Z' } };
    const result = await verify(proofFile);
    expect(result.rootAnchored).toBe(false);
    expect(result.signedCheckpoints?.temporal?.postHocSuspected).toBe(true);
  });
});
