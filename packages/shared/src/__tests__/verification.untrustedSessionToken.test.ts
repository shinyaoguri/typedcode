/**
 * 検証できないセッション開始トークンを「改ざん」ではなく「開始時刻の根拠なし」として扱う (#329)。
 *
 * token の検証失敗 (registry に無い keyId / 署名不正 / fingerprintHash の不一致) は、root が
 * serverNonce 込みの式 (ADR-0017) で自己整合している限り、内容の改ざんではない。古い registry を
 * 同梱した検証器で新しい鍵の token を見ると正直な proof が「改ざん」と表示されていた。
 * 署名 cp の未知 keyId (`valid` だけが落ち、整合性は残る) と同じ扱いにそろえる。
 *
 * 一方、token の serverNonce を書き換えて root が合わなくなった proof は従来どおり改ざんとして落とす。
 *
 * 前提: vitest の `setup.ts` は Worker を偽の PoSW を返す MockWorker に差し替えている。整合性を
 * `proven` (full モード) で確かめたいので、このファイルでは検証側と同じ同期 SHA-256 反復で本物の
 * PoSW を計算するスタブに差し替える。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
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
import { iterateSha256HexSync } from '../utils/hashUtils.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

/** PoSW を本当に計算する Worker スタブ (`poswWorker.ts` と同じ入力。`verifyPoSW` の再計算と一致する)。 */
class RealPoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage) return;
      if (message.type !== 'compute-posw') {
        this.onmessage({ data: { type: 'verify-result', requestId: message.requestId, valid: true } } as MessageEvent);
        return;
      }
      const iterations = message.iterations as number;
      const nonce = 'ab'.repeat(16);
      const intermediateHash = iterateSha256HexSync(
        `${message.previousHash as string}${message.eventDataString as string}${nonce}`,
        iterations
      );
      this.onmessage({
        data: {
          type: 'posw-result',
          requestId: message.requestId,
          iterations,
          nonce,
          intermediateHash,
          computeTimeMs: 1,
        },
      } as MessageEvent);
    });
  }

  terminate(): void {
    // no-op
  }
}

vi.stubGlobal('Worker', RealPoswWorkerStub);

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Untrusted Session Token Test)',
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
const SESSION_ID = 'session-untrusted-token';

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
 * root を `tokenKey` の token でアンカーして a / b / c を打った proof を作る。
 * `checkpointKey` を渡すと、その鍵で全イベントに署名 cp を付ける (token と同じ sessionId)。
 * `tokenFingerprintHash` を渡すと、token だけ別の端末向けに発行されたものにする。
 */
async function buildProof(options: { tokenKey: TestKey; checkpointKey?: TestKey; tokenFingerprintHash?: string }) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(options.tokenKey, options.tokenFingerprintHash ?? fingerprintHash);

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
  const checkpoints = options.checkpointKey
    ? await buildSignedCheckpoints({
        events: exported.proof.events,
        initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
        key: options.checkpointKey,
        sessionId: SESSION_ID,
      })
    : [];
  return { ...exported, checkpoints, content, language: 'text' };
}

type BuiltProof = Awaited<ReturnType<typeof buildProof>>;

/** verify-cli `verify.ts` の `deriveAssurance` 呼び出しと同じ写像 (分析・スクショは省く)。 */
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

/** 検証器が信頼する鍵 (registry に載る)。token を発行した鍵とは別。 */
let verifierKey: TestKey;
/** token を発行した鍵。検証器の registry には載せない (= 古い registry で新しい鍵の token を見る状況)。 */
let unknownKey: TestKey;

beforeAll(async () => {
  verifierKey = await createTestKey();
  unknownKey = await createTestKey();
});

const verifyFull = (proofFile: BuiltProof, options: { requireRootAnchor?: boolean } = {}) =>
  verifyProofFile(proofFile, undefined, {
    mode: 'full',
    signedCheckpointKeyRegistry: [verifierKey.registryEntry],
    requireRootAnchor: options.requireRootAnchor,
  });

describe('verifyProofFile: a session start token signed by a key outside the registry (#329)', () => {
  it('keeps metadata and root valid when the root is self-consistent with the token serverNonce', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    expect(result.metadataValid).toBe(true);
    expect(result.rootValid).toBe(true);
    expect(result.chainValid).toBe(true);
  });

  it('does not report the root as server-anchored', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    expect(result.rootAnchored).toBe(false);
  });

  it('returns the anchor failure as token-unknown-key with the keyId and an outdated-registry hint', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    expect(result.rootAnchorFailure?.code).toBe('token-unknown-key');
    expect(result.rootAnchorFailure?.keyId).toBe(unknownKey.keyId);
    expect(result.rootAnchorFailure?.reason).toContain(unknownKey.keyId);
    expect(result.rootAnchorFailure?.reason).toMatch(/registry may be outdated/);
  });

  it('states in the reason that this is not content tampering', async () => {
    // verify-cli は理由を Error 行にそのまま出す。「改ざん」と読まれないことが #329 の本題。
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    expect(result.rootAnchorFailure?.reason).toMatch(/^Start time unanchored \(not content tampering\): /);
  });

  it('fails overall with the anchor failure as the error message', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(result.rootAnchorFailure?.reason);
  });

  it('derives integrity proven and temporal unanchored when there is no signed checkpoint', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }));

    const assurance = deriveAssurance(toAssuranceInput(result));
    expect(assurance.integrity).toBe('proven');
    expect(assurance.temporal).toBe('unanchored');
  });

  it('derives temporal partial, not anchored, when a trusted signed checkpoint covers every event', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey, checkpointKey: verifierKey }));

    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(true);
    const assurance = deriveAssurance(toAssuranceInput(result));
    expect(assurance.integrity).toBe('proven');
    expect(assurance.temporal).toBe('partial');
  });

  it('reports the token failure, not the generic gate message, when root anchoring is required', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: unknownKey }), { requireRootAnchor: true });

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(result.rootAnchorFailure?.reason);
  });
});

describe('verifyProofFile: a session start token with a broken signature (#329)', () => {
  it('returns the anchor failure as token-invalid without suggesting an outdated registry', async () => {
    const proofFile = await buildProof({ tokenKey: verifierKey });
    // 署名の先頭 1 文字だけ変える。payload (serverNonce) は無傷なので root は自己整合したまま。
    const token = proofFile.sessionStartToken!;
    const flipped = (token.signature[0] === 'a' ? 'b' : 'a') + token.signature.slice(1);
    const result = await verifyFull({ ...proofFile, sessionStartToken: { ...token, signature: flipped } });

    expect(result.metadataValid).toBe(true);
    expect(result.rootAnchored).toBe(false);
    expect(result.rootAnchorFailure?.code).toBe('token-invalid');
    expect(result.rootAnchorFailure?.reason).not.toMatch(/registry may be outdated/);
    expect(result.valid).toBe(false);
  });

  it('carries the underlying token verification reason into the anchor failure reason', async () => {
    const proofFile = await buildProof({ tokenKey: verifierKey });
    const token = proofFile.sessionStartToken!;
    const flipped = (token.signature[0] === 'a' ? 'b' : 'a') + token.signature.slice(1);
    const result = await verifyFull({ ...proofFile, sessionStartToken: { ...token, signature: flipped } });

    expect(result.rootAnchorFailure?.reason).toContain('(Session token signature is invalid)');
  });
});

describe('verifyProofFile: a session start token issued for another device fingerprint (#329)', () => {
  it('returns the anchor failure as token-fingerprint-mismatch while keeping integrity proven', async () => {
    const result = await verifyFull(await buildProof({ tokenKey: verifierKey, tokenFingerprintHash: '0'.repeat(64) }));

    expect(result.metadataValid).toBe(true);
    expect(result.rootAnchored).toBe(false);
    expect(result.rootAnchorFailure?.code).toBe('token-fingerprint-mismatch');
    expect(result.valid).toBe(false);
    expect(deriveAssurance(toAssuranceInput(result)).integrity).toBe('proven');
  });
});

describe('verifyProofFile: a rewritten token serverNonce stays tampering (#329)', () => {
  it('fails integrity because the root no longer matches the serverNonce', async () => {
    const proofFile = await buildProof({ tokenKey: verifierKey });
    const token = proofFile.sessionStartToken!;
    const result = await verifyFull({
      ...proofFile,
      sessionStartToken: { ...token, payload: { ...token.payload, serverNonce: 'b2'.repeat(32) } },
    });

    expect(result.metadataValid).toBe(false);
    expect(result.rootValid).toBe(false);
    expect(result.rootAnchorFailure).toBeUndefined();
    expect(deriveAssurance(toAssuranceInput(result)).integrity).toBe('failed');
  });
});
