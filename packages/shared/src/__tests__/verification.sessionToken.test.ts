/**
 * verifyProofFile の「アンカー層」の拒否分岐を shared の中で守るテスト (#499, 変異検査 系統 5)。
 *
 * - ADR-0017 / spec §6.3: セッション開始トークンの sessionId が署名 cp の sessionId と食い違う proof
 *   (別セッションのトークン流用) を弾く。root は自己整合するので、ほかの層では捕まらない。
 * - ADR-0020: 署名 cp が存在しつつ無効なら全体も無効にする。署名だけを壊しても未署名 cp の
 *   照合や連鎖は通るので、`signedCheckpointBlocks` の判定でしか落ちない。
 *
 * 判定の持ち主は shared の `verifyProofFile` (verify-cli は薄いラッパ)。verify の
 * `webCliParity.test.ts` は Web と CLI の結論の一致を固定するテストで、判定の正しさはここで守る。
 * MockWorker が PoSW を偽データで返すので `mode: 'fast'` で呼ぶ。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  createSessionStartToken,
  verifyProofFile,
  type CheckpointData,
  type FingerprintComponents,
  type SessionStartToken,
} from '../index.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Session Token Verification Test)',
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

async function makeToken(key: TestKey, sessionId: string, fingerprintHash: string): Promise<SessionStartToken> {
  return createSessionStartToken(
    { sessionId, fingerprintHash },
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
 * root がサーバアンカーされ、署名 cp も付いた proof を作る。
 * `tokenSessionId` と `checkpointSessionId` を別々に指定できるのは、別セッションの
 * トークンを流用した proof を再現するため。
 */
async function buildAnchoredProof(options: {
  tokenSessionId: string;
  checkpointSessionId: string;
  /** 署名 cp の payload に焼く root。省略時はこの proof 自身の root */
  checkpointRoot?: string;
}) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(testKey, options.tokenSessionId, fingerprintHash);

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
    initialEventChainHash: options.checkpointRoot ?? exported.typingProofData.initialEventChainHash ?? '',
    key: testKey,
    sessionId: options.checkpointSessionId,
  });
  return { ...exported, checkpoints, content, language: 'text' };
}

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

const verifyFast = (proofFile: Awaited<ReturnType<typeof buildAnchoredProof>>) =>
  verifyProofFile(proofFile, undefined, {
    mode: 'fast',
    signedCheckpointKeyRegistry: [testKey.registryEntry],
  });

describe('verifyProofFile: session start token sessionId vs signed checkpoint (ADR-0017 / spec §6.3)', () => {
  it('accepts an untampered anchored proof whose token and signed checkpoints share a sessionId', async () => {
    const proofFile = await buildAnchoredProof({ tokenSessionId: 'session-A', checkpointSessionId: 'session-A' });
    const result = await verifyFast(proofFile);

    expect(result.valid).toBe(true);
    expect(result.rootAnchored).toBe(true);
    expect(result.sessionTokenMismatch).toBe(false);
    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(true);
  });

  it('rejects a proof that reuses a session start token issued for another session', async () => {
    // root はトークンの serverNonce で自己整合し、署名 cp も正当。食い違うのは sessionId だけ。
    const proofFile = await buildAnchoredProof({ tokenSessionId: 'session-A', checkpointSessionId: 'session-B' });
    const result = await verifyFast(proofFile);

    expect(result.rootValid).toBe(true);
    expect(result.chainValid).toBe(true);
    expect(result.sessionTokenMismatch).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Session start token sessionId does not match signed checkpoint sessionId');
  });
});

describe('verifyProofFile: invalid signed checkpoint fails the whole proof (ADR-0020)', () => {
  it('fails overall when only a signed checkpoint signature is broken (chain and unsigned checks stay intact)', async () => {
    const proofFile = await buildAnchoredProof({ tokenSessionId: 'session-A', checkpointSessionId: 'session-A' });
    // 署名の先頭 1 文字だけ変える。cp の hash / timestamp / contentHash とチェーン・内容は無傷。
    const checkpoints = (proofFile.checkpoints ?? []).map((cp, index): CheckpointData => {
      if (index !== 0 || !cp.signature) return cp;
      const signature = cp.signature.signature;
      const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
      return { ...cp, signature: { ...cp.signature, signature: flipped } };
    });
    const result = await verifyFast({ ...proofFile, checkpoints });

    expect(result.chainValid).toBe(true);
    expect(result.checkpointValid).toBe(true);
    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Signed checkpoint signature invalid at event 0');
  });
});

describe('verifyProofFile: signed checkpoints anchored to another proof root (#580)', () => {
  it('fails the signed checkpoint layer when the checkpoints carry the root of another proof', async () => {
    // 署名・連鎖・event との一致はすべて正しく、payload の root だけが別 proof のもの。
    // 照合は verifyProofSignedCheckpoints が proof の root を渡したときだけ働く。
    const other = await buildAnchoredProof({ tokenSessionId: 'session-A', checkpointSessionId: 'session-A' });
    const otherRoot = other.typingProofData.initialEventChainHash;
    if (!otherRoot) throw new Error('fixture proof has no root');
    const proofFile = await buildAnchoredProof({
      tokenSessionId: 'session-A',
      checkpointSessionId: 'session-A',
      checkpointRoot: otherRoot,
    });
    const result = await verifyFast(proofFile);

    expect(result.chainValid).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe('Signed checkpoint initialEventChainHash does not match proof root');
  });
});
