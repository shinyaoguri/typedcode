/**
 * 未署名の末尾を持つ proof の三層保証 (#295) を、proof の生成から `deriveAssurance` まで通して固定する。
 *
 * 再現の形: root はサーバアンカー済み (sessionStartToken)、署名 cp は先頭のイベントだけ。残りの
 * イベントはどのサーバ署名にも覆われていない (オフラインで書き足せる)。それでも密度は「疎」にならず
 * (短いセッション)、post-hoc も立たないので、最終イベントへの署名を見ない限り `anchored` に見えていた。
 *
 * 写像 (`FullVerificationResult` → `AssuranceInput`) は verify-cli の `verify.ts` と同じ形をここに
 * 置く。verify-cli / verify Web の実際の写像どうしの一致は verify の `webCliParity.test.ts` が見る。
 * MockWorker が PoSW を偽データで返すので `mode: 'fast'` で呼ぶ (`verification.sessionToken.test.ts` と同じ)。
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
  type SessionStartToken,
} from '../index.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Unsigned Tail Test)',
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

const SERVER_NONCE = 'a1'.repeat(32); // 64-hex
const SESSION_ID = 'session-unsigned-tail';

async function makeToken(key: TestKey, fingerprintHash: string): Promise<SessionStartToken> {
  return createSessionStartToken(
    { sessionId: SESSION_ID, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: '2026-06-12T00:00:00.000Z',
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
}

/**
 * root アンカー済みで a / b / c を打った proof に、`signedEventIndexes` のイベントだけ署名 cp を付ける。
 * 省略時は全イベントに署名 (最終イベントまで届く正常形)。
 */
async function buildAnchoredProof(signedEventIndexes?: number[]) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(testKey, fingerprintHash);

  const typingProof = new TypingProof();
  await typingProof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  let content = '';
  for (const ch of 'abc') {
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
    eventIndexes: signedEventIndexes,
  });
  return { ...exported, checkpoints, content, language: 'text' };
}

type AnchoredProof = Awaited<ReturnType<typeof buildAnchoredProof>>;

/** 採点向けの厳しい gate (root アンカー必須・密度必須) を立てて検証する。 */
const verifyStrict = (proofFile: AnchoredProof) =>
  verifyProofFile(proofFile, undefined, {
    mode: 'fast',
    requireRootAnchor: true,
    requireAnchorDensity: true,
    signedCheckpointKeyRegistry: [testKey.registryEntry],
  });

/** verify-cli `verify.ts` の `deriveAssurance` 呼び出しと同じ写像 (分析・スクショは時刻層に効かないので省く)。 */
function toAssuranceInput(result: FullVerificationResult): AssuranceInput {
  return {
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
}

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

describe('assurance for an anchored proof whose last events are not signed (#295)', () => {
  it('reports temporal partial when only the first event carries a signed checkpoint', async () => {
    const proofFile = await buildAnchoredProof([0]);
    const result = await verifyStrict(proofFile);

    // 前提: 厳しい gate を全部立てても proof 自体は通る (valid の判定は #296 の範囲で、本件は変えない)。
    expect(result.valid).toBe(true);
    expect(result.rootAnchored).toBe(true);
    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('partial');
  });

  it('still recovers the final content from a proof with an unsigned tail', async () => {
    const proofFile = await buildAnchoredProof([0]);
    const result = await verifyStrict(proofFile);

    expect(proofFile.content).toBe('abc');
    expect(result.contentValid).toBe(true);
  });

  it('does not upgrade to anchored after the proof is serialized and re-verified', async () => {
    const proofFile = await buildAnchoredProof([0]);
    const reloaded = JSON.parse(JSON.stringify(proofFile)) as AnchoredProof;
    const result = await verifyStrict(reloaded);

    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('partial');
  });

  it('reports temporal anchored when every event up to the final one is signed', async () => {
    const proofFile = await buildAnchoredProof();
    const result = await verifyStrict(proofFile);

    expect(result.valid).toBe(true);
    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('anchored');
  });
});
