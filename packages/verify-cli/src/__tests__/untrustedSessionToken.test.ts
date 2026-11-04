/**
 * 検証できないセッション開始トークンを持つ proof の CLI 表示と終了コード (#329)。
 *
 * 古い registry を同梱した verify-cli で新しい鍵の token を見ると、正直な proof が「改ざん」と
 * 表示されていた。判定 (shared の `verifyProofFile`) は root が serverNonce 込みの式で自己整合して
 * いれば整合性を残し、`rootAnchorFailure` で理由を返す。CLI が守るのは次の 3 点:
 *
 * - 総合は FAILED (exit 1) のまま。開始時刻の根拠が無い proof を合格にはしない
 * - 失敗理由は「改ざんではない」と読める文言で、keyId と「registry が古い可能性」を出す
 * - `Root anchor:` 行は token があるのに `no session start token` と出さない (事実に反する)
 *
 * PoSW の再計算はスタブ Worker では回せないので `fast` で検証する (整合性の `proven` は shared の
 * `verification.untrustedSessionToken.test.ts` が full モードで見る)。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  createSessionStartToken,
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

/**
 * テスト中だけ存在する ECDSA-P256 鍵 (shared の `signedCheckpointFixtures.ts` と同じ形)。
 * verify-cli の tsconfig は rootDir が src なので、shared のテスト fixture を相対 import できない。
 */
async function createTestKey(): Promise<TestKey> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  const keyId = `test-key-${Math.random().toString(16).slice(2, 10)}`;
  return {
    keyId,
    privateKey: keyPair.privateKey,
    registryEntry: {
      keyId,
      algorithm: 'ECDSA-P256',
      publicKeyJwk,
      status: 'active',
      validFrom: '2020-01-01T00:00:00Z',
      description: 'test key',
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
      const data =
        message.type === 'compute-posw'
          ? {
              type: 'posw-result',
              requestId: message.requestId,
              iterations: message.iterations,
              nonce: 'stub-nonce',
              intermediateHash: 'stub-intermediate-hash',
              computeTimeMs: 1,
            }
          : { type: 'verify-result', requestId: message.requestId, valid: true };
      this.onmessage({ data } as MessageEvent);
    });
  }

  terminate(): void {
    // no-op
  }
}

const components: FingerprintComponents = {
  userAgent: 'TypedCode verify-cli untrusted token test',
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

const SERVER_NONCE = 'a1'.repeat(32);

/** `tokenKey` の token で root をアンカーした proof (署名 cp なし)。 */
async function buildProof(tokenKey: TestKey): Promise<ProofFile> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await createSessionStartToken(
    { sessionId: 'session-cli-untrusted', fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: '2026-06-12T00:00:00.000Z',
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: tokenKey.keyId, privateKey: tokenKey.privateKey }
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
  return { ...exported, content, language: 'javascript' };
}

/** 色付けは TTY 依存 (module load 時に決まる) なので、比較前に ANSI を落とす。 */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの除去そのものが目的
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** token を発行した鍵。検証器の registry には載せない。 */
let issuerKey: TestKey;
/** 検証器が信頼する鍵 (issuerKey とは別)。 */
let verifierKey: TestKey;
let proofFile: ProofFile;

beforeAll(async () => {
  issuerKey = await createTestKey();
  verifierKey = await createTestKey();
  proofFile = await buildProof(issuerKey);
});

const verifyWithOutdatedRegistry = () =>
  verifyProof(proofFile, { mode: 'fast', signedCheckpointKeyRegistry: [verifierKey.registryEntry] });

describe('verify-cli: a session start token signed by a key outside the registry (#329)', () => {
  it('fails the proof overall without failing integrity', async () => {
    const result = await verifyWithOutdatedRegistry();

    expect(result.valid).toBe(false);
    expect(result.metadataValid).toBe(true);
    expect(result.assurance.integrity).not.toBe('failed');
    expect(result.rootAnchorFailure?.code).toBe('token-unknown-key');
  });

  it('prints an error that names the keyId, says it is not tampering, and hints at an outdated registry', async () => {
    const text = plain(formatResult(await verifyWithOutdatedRegistry()));

    const errorLine = text.split('\n').find((line) => line.startsWith('  Error: '));
    expect(errorLine).toContain(issuerKey.keyId);
    expect(errorLine).toContain('not content tampering');
    expect(errorLine).toMatch(/registry may be outdated/);
  });

  it('prints the root anchor as untrusted with the keyId, not as a missing token', async () => {
    const text = plain(formatResult(await verifyWithOutdatedRegistry()));

    const rootLine = text.split('\n').find((line) => line.startsWith('Root anchor: '));
    expect(rootLine).toMatch(/^Root anchor: UNTRUSTED /);
    expect(rootLine).toContain(issuerKey.keyId);
    expect(rootLine).not.toContain('no session start token');
  });

  it('sanitizes a keyId carrying control characters before printing the root anchor line', async () => {
    const result = await verifyWithOutdatedRegistry();
    const forged = {
      ...result,
      rootAnchorFailure: { ...result.rootAnchorFailure!, keyId: 'k\nRoot anchor: VERIFIED' },
    };

    const lines = plain(formatResult(forged)).split('\n');

    expect(lines.filter((line) => line.startsWith('Root anchor: '))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('Root anchor: VERIFIED'))).toBe(false);
  });

  it('exits 1 as a process with the default registry, which does not know the test key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-verify-cli-token-'));
    const path = join(dir, 'untrusted_proof.json');
    writeFileSync(path, JSON.stringify(proofFile), 'utf-8');

    const res = runSourceCli(['--mode', 'fast', path]);

    expect(res.exitCode).toBe(1);
    expect(plain(res.stdout)).toContain('not content tampering');
    expect(plain(res.stdout)).not.toContain('no session start token');
  });
});
