/**
 * staging の鍵で署名された proof の CLI の結論と表示 (#321)。
 *
 * registry には production と staging の鍵が並ぶ。verify-cli は既定で production (と手元の development) の
 * 鍵だけを時刻証拠に数え、staging の Worker が発行した token / 署名した cp は `--allow-staging-keys` を
 * 付けたときだけ数える。数えないときも proof は改ざんではないので合否 (exit code) と整合性は落とさず、
 * `Root anchor:` / `Anchoring:` 行に staging の鍵であることを出す。
 *
 * 本物の staging の秘密鍵は持てないので、テスト鍵を staging として registry に注入して `verifyProof` を呼ぶ。
 * PoSW の再計算はスタブ Worker では回せないので `fast` で検証する。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  createSessionStartToken,
  createSignedCheckpointEnvelope,
  type CheckpointKeyEnvironment,
  type CheckpointPublicKey,
  type FingerprintComponents,
  type ProofFile,
} from '@typedcode/shared';
import { formatResult } from '../output.js';
import { verifyProof } from '../verify.js';
import { runSourceCli } from './helpers/runCli.js';

interface TestKey {
  keyId: string;
  privateKey: CryptoKey;
  registryEntry: CheckpointPublicKey;
}

/** verify-cli の tsconfig は rootDir が src なので、shared のテスト fixture を相対 import できない。 */
async function createTestKey(environment: CheckpointKeyEnvironment): Promise<TestKey> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  const keyId = `test-${environment}-${Math.random().toString(16).slice(2, 10)}`;
  return {
    keyId,
    privateKey: keyPair.privateKey,
    registryEntry: {
      keyId,
      algorithm: 'ECDSA-P256',
      publicKeyJwk,
      status: 'active',
      validFrom: '2020-01-01T00:00:00Z',
      environment,
    },
  };
}

/** 固定値の PoSW を返す Worker スタブ (fast モードでしか検証しない)。 */
class PoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage) return;
      if (message.type !== 'compute-posw') return;
      const data = {
        type: 'posw-result',
        requestId: message.requestId,
        iterations: message.iterations,
        nonce: 'stub-nonce',
        intermediateHash: 'stub-intermediate-hash',
        computeTimeMs: 1,
      };
      this.onmessage({ data } as MessageEvent);
    });
  }

  terminate(): void {
    // no-op
  }
}

const components: FingerprintComponents = {
  userAgent: 'TypedCode verify-cli staging key test',
  language: 'en',
  languages: ['en'],
  platform: 'FixtureOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: { width: 1, height: 1, availWidth: 1, availHeight: 1, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'fixture',
  webgl: { vendor: 'fixture', renderer: 'fixture' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

const SERVER_NONCE = 'd4'.repeat(32);
const SESSION_ID = 'session-cli-staging';
const ISSUED_AT_MS = Date.parse('2026-06-12T00:00:00.000Z');

/**
 * `key` の token で root をアンカーし、最終イベントに同じ鍵で署名 cp を 1 つ付けた proof
 * (= その環境の Worker と正直にやり取りしたセッション)。
 */
async function buildProof(key: TestKey): Promise<ProofFile> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await createSessionStartToken(
    { sessionId: SESSION_ID, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: new Date(ISSUED_AT_MS).toISOString(),
      turnstileVerified: true,
      hostname: 'staging.typedcode.pages.dev',
      action: 'create_tab',
    },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
  const proof = new TypingProof();
  await proof.initializeAnchored(
    fingerprintHash,
    components,
    SERVER_NONCE,
    token,
    new PoswWorkerStub() as unknown as Worker
  );
  let content = '';
  for (const ch of 'ok') {
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await proof.exportProof(content);
  const events = exported.proof.events;
  const lastIndex = events.length - 1;
  const last = events[lastIndex]!;
  const contentHash = last.data
    ? await computeHash(typeof last.data === 'string' ? last.data : JSON.stringify(last.data))
    : '';
  const serverTimestamp = new Date(ISSUED_AT_MS + 1_000).toISOString();
  const signature = await createSignedCheckpointEnvelope(
    {
      sessionId: SESSION_ID,
      tabId: 'tab-1',
      checkpointIndex: 0,
      eventIndex: lastIndex,
      initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
      chainHash: last.hash,
      contentHash,
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: lastIndex + 1,
      clientTimestamp: serverTimestamp,
    },
    { serverTimestamp, firstSeenAt: serverTimestamp },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
  const checkpoints = [{ eventIndex: lastIndex, hash: last.hash, timestamp: last.timestamp, contentHash, signature }];
  return { ...exported, checkpoints, content, language: 'javascript' };
}

/** 色付けは TTY 依存 (module load 時に決まる) なので、比較前に ANSI を落とす。 */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの除去そのものが目的
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

let productionKey: TestKey;
let stagingKey: TestKey;
let stagingProof: ProofFile;

beforeAll(async () => {
  productionKey = await createTestKey('production');
  stagingKey = await createTestKey('staging');
  stagingProof = await buildProof(stagingKey);
});

/** 本番の registry と同じく production と staging の鍵が並ぶ */
const verifyStaging = (options: { allowStagingKeys?: boolean } = {}) =>
  verifyProof(stagingProof, {
    mode: 'fast',
    signedCheckpointKeyRegistry: [productionKey.registryEntry, stagingKey.registryEntry],
    ...options,
  });

const lineStartingWith = (text: string, prefix: string) => text.split('\n').find((line) => line.startsWith(prefix));

describe('verify-cli: a proof signed by a staging key without --allow-staging-keys (#321)', () => {
  it('does not derive the timeline as anchored', async () => {
    const result = await verifyStaging();

    expect(result.assurance.temporal).toBe('unanchored');
  });

  it('keeps the proof valid and its integrity intact', async () => {
    const result = await verifyStaging();

    expect(result.valid).toBe(true);
    expect(result.assurance.integrity).toBe('partial');
  });

  it('prints the root anchor as unanchored because the token is signed by a staging key', async () => {
    const rootLine = lineStartingWith(plain(formatResult(await verifyStaging())), 'Root anchor: ');

    expect(rootLine).toMatch(/^Root anchor: unanchored \(session start token is signed by a staging key /);
    expect(rootLine).toContain(stagingKey.keyId);
    expect(rootLine).toContain('--allow-staging-keys');
  });

  it('prints the anchoring as unavailable because the checkpoints are signed by a staging key', async () => {
    const anchoringLine = lineStartingWith(plain(formatResult(await verifyStaging())), 'Anchoring:   ');

    expect(anchoringLine).toMatch(/^Anchoring: {3}unavailable \(signed checkpoints are signed by a staging key /);
    expect(anchoringLine).toContain(stagingKey.keyId);
  });
});

describe('verify-cli: the same proof with --allow-staging-keys (#321)', () => {
  it('derives the timeline as anchored', async () => {
    const result = await verifyStaging({ allowStagingKeys: true });

    expect(result.assurance.temporal).toBe('anchored');
  });

  it('derives the same integrity as without the flag', async () => {
    const withFlag = await verifyStaging({ allowStagingKeys: true });
    const withoutFlag = await verifyStaging();

    expect(withFlag.assurance.integrity).toBe(withoutFlag.assurance.integrity);
  });

  it('prints the root anchor and the anchoring as verified', async () => {
    const text = plain(formatResult(await verifyStaging({ allowStagingKeys: true })));

    expect(lineStartingWith(text, 'Root anchor: ')).toMatch(/^Root anchor: VERIFIED/);
    expect(lineStartingWith(text, 'Anchoring:   ')).toMatch(/^Anchoring: {3}VERIFIED/);
  });
});

describe('verify-cli: --allow-staging-keys as a process (#321)', () => {
  it('accepts the flag instead of failing it as an unknown option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-verify-cli-staging-'));
    const path = join(dir, 'staging_proof.json');
    // 既定の registry はテスト鍵を知らない。ここではフラグが usage error にならないことだけを見る
    writeFileSync(path, JSON.stringify(stagingProof), 'utf-8');

    const res = runSourceCli(['--mode', 'fast', '--allow-staging-keys', path]);

    expect(plain(res.stderr)).not.toMatch(/unknown/i);
    expect(plain(res.stdout)).toContain('=== TypedCode Proof Verification ===');
  });
});
