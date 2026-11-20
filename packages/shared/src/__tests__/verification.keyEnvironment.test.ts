/**
 * staging の鍵で署名された時刻証拠を、既定の検証器が時刻アンカーに数えない (#321)。
 *
 * registry には production と staging の鍵が並んで載る。staging は main への push ごとに自動デプロイされ、
 * 鍵の管理水準も本番より低い。かつては環境の区別が無く、staging の Worker が発行した token と署名 cp を
 * 本番の検証器が `anchored` と表示していた。
 *
 * 規則 (ADR-0002 の #321 の追記):
 * - 検証器は registry の全鍵で署名を検証した後で、その鍵の環境を信頼するかを決める。既定は production と
 *   development (gitignore 済みの localKeys)。staging は明示したときだけ信頼する
 * - 信頼しない環境の鍵の証拠は「無い」ものとして扱う: temporal を anchored / partial に上げない
 * - 整合性 (ハッシュ) と総合の `valid` は落とさない (改ざんではない)。署名そのものが壊れていれば従来どおり失敗
 *
 * 前提: vitest の `setup.ts` は Worker を偽の PoSW を返す MockWorker に差し替えている。整合性を
 * `proven` (full モード) で確かめたいので、検証側と同じ同期 SHA-256 反復で本物の PoSW を計算するスタブに
 * 差し替える (`verification.untrustedSessionToken.test.ts` と同じ)。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TypingProof,
  computeHash,
  createSessionStartToken,
  deriveAssurance,
  trustedCheckpointKeyEnvironments,
  verifyProofFile,
  type AssuranceInput,
  type CheckpointKeyEnvironment,
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
      if (message.type !== 'compute-posw') return;
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
  userAgent: 'Mozilla/5.0 (Key Environment Test)',
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

const SERVER_NONCE = 'c3'.repeat(32); // 64-hex
const SESSION_ID = 'session-key-environment';

async function makeToken(key: TestKey, fingerprintHash: string): Promise<SessionStartToken> {
  return createSessionStartToken(
    { sessionId: SESSION_ID, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: '2026-05-28T12:00:00.500Z',
      turnstileVerified: true,
      hostname: 'staging.typedcode.pages.dev',
      action: 'create_tab',
    },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
}

/**
 * root を `key` の token でアンカーし、a / b / c を打って全イベントに同じ鍵で署名 cp を付けた proof
 * (= その環境の Worker と正直にやり取りしたセッション)。
 */
async function buildProof(key: TestKey) {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(key, fingerprintHash);

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
    key,
    sessionId: SESSION_ID,
  });
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

let productionKey: TestKey;
let stagingKey: TestKey;
let developmentKey: TestKey;
let stagingProof: BuiltProof;

beforeAll(async () => {
  productionKey = await createTestKey({ environment: 'production' });
  stagingKey = await createTestKey({ environment: 'staging' });
  developmentKey = await createTestKey({ environment: 'development' });
  stagingProof = await buildProof(stagingKey);
});

/** 本番の registry と同じく production と staging の鍵が並ぶ (検証器はどちらの署名も検証できる)。 */
const registry = () => [productionKey.registryEntry, stagingKey.registryEntry, developmentKey.registryEntry];

const verify = (
  proofFile: BuiltProof,
  options: { trusted?: readonly CheckpointKeyEnvironment[]; requireRootAnchor?: boolean } = {}
) =>
  verifyProofFile(proofFile, undefined, {
    mode: 'full',
    signedCheckpointKeyRegistry: registry(),
    ...(options.trusted ? { trustedKeyEnvironments: options.trusted } : {}),
    requireRootAnchor: options.requireRootAnchor,
  });

const allowingStaging = () => trustedCheckpointKeyEnvironments({ allowStaging: true });

describe('verifyProofFile: evidence signed by a staging key under the default trust (#321)', () => {
  it('does not derive temporal anchored from a staging-signed token and signed checkpoints', async () => {
    const result = await verify(stagingProof);

    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('unanchored');
  });

  it('does not report the root as server-anchored by a staging token', async () => {
    const result = await verify(stagingProof);

    expect(result.rootAnchored).toBe(false);
  });

  it('names the staging token key and its environment as the reason the root is unanchored', async () => {
    const result = await verify(stagingProof);

    expect(result.rootAnchorUntrustedKey).toEqual({ keyId: stagingKey.keyId, environment: 'staging' });
  });

  it('counts no staging-signed checkpoint as anchoring evidence', async () => {
    const result = await verify(stagingProof);

    expect(result.signedCheckpoints?.anchored).toBe(false);
    expect(result.signedCheckpoints?.coverage.signedCount).toBe(0);
  });

  it('names the staging checkpoint key and its environment as the reason the checkpoints do not count', async () => {
    const result = await verify(stagingProof);

    expect(result.signedCheckpoints?.untrustedKeys).toEqual([{ keyId: stagingKey.keyId, environment: 'staging' }]);
  });

  it('keeps the overall verdict valid because staging evidence is absent evidence, not tampering', async () => {
    const result = await verify(stagingProof);

    expect(result.valid).toBe(true);
    expect(result.integrityValid).toBe(true);
    expect(result.rootAnchorFailure).toBeUndefined();
  });

  it('fails the root anchor policy because a staging token does not anchor the root', async () => {
    const result = await verify(stagingProof, { requireRootAnchor: true });

    expect(result.valid).toBe(false);
    expect(result.policy.violations.map((v) => v.code)).toEqual(['root-anchor-missing']);
  });

  it('still fails a staging-signed checkpoint whose signature is broken', async () => {
    const [first, ...rest] = stagingProof.checkpoints;
    const signature = first!.signature!;
    const flipped = (signature.signature[0] === 'a' ? 'b' : 'a') + signature.signature.slice(1);
    const broken = {
      ...stagingProof,
      checkpoints: [{ ...first!, signature: { ...signature, signature: flipped } }, ...rest],
    };

    const result = await verify(broken);

    expect(result.signedCheckpoints?.anchored).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(false);
    expect(result.valid).toBe(false);
  });
});

describe('verifyProofFile: the same staging proof with and without trusting staging (#321)', () => {
  it('derives the same integrity whether or not staging keys are trusted', async () => {
    const byDefault = deriveAssurance(toAssuranceInput(await verify(stagingProof)));
    const allowing = deriveAssurance(toAssuranceInput(await verify(stagingProof, { trusted: allowingStaging() })));

    expect(byDefault.integrity).toBe('proven');
    expect(allowing.integrity).toBe(byDefault.integrity);
  });

  it('derives temporal anchored once staging keys are explicitly trusted', async () => {
    const result = await verify(stagingProof, { trusted: allowingStaging() });

    expect(result.rootAnchored).toBe(true);
    expect(result.rootAnchorUntrustedKey).toBeUndefined();
    expect(result.signedCheckpoints?.untrustedKeys).toBeUndefined();
    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('anchored');
  });
});

describe('verifyProofFile: production and development keys are trusted by default (#321)', () => {
  it('derives temporal anchored from production-signed evidence', async () => {
    const result = await verify(await buildProof(productionKey));

    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('anchored');
  });

  it('derives temporal anchored from development (local) key evidence', async () => {
    const result = await verify(await buildProof(developmentKey));

    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('anchored');
  });

  it('does not trust evidence from a registry entry that has no environment', async () => {
    // JSON から読んだ registry を注入されたとき (型を通らない) に、環境の無い鍵を素通しさせない (fail-closed)
    const { environment: _omitted, ...withoutEnvironment } = productionKey.registryEntry;
    const result = await verifyProofFile(await buildProof(productionKey), undefined, {
      mode: 'full',
      signedCheckpointKeyRegistry: [withoutEnvironment as typeof productionKey.registryEntry],
    });

    expect(result.rootAnchorUntrustedKey).toStrictEqual({ keyId: productionKey.keyId });
    expect(result.signedCheckpoints?.untrustedKeys).toStrictEqual([{ keyId: productionKey.keyId }]);
    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('unanchored');
  });

  it('does not trust production evidence when the caller trusts only staging', async () => {
    const result = await verify(await buildProof(productionKey), { trusted: ['staging'] });

    expect(result.rootAnchorUntrustedKey).toEqual({ keyId: productionKey.keyId, environment: 'production' });
    expect(deriveAssurance(toAssuranceInput(result)).temporal).toBe('unanchored');
  });
});
