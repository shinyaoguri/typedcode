/**
 * セッション開始トークン (ADR-0017) の検証ロジックに対するテスト。
 *
 * - createSessionStartToken / verifySessionStartToken (registry-only = C1)
 * - computeAnchoredChainRoot が HashChainManager.generateAnchoredInitialHash と一致すること
 * - 実 proof を initializeAnchored で生成し、verifyInitialHashRoot が serverNonce 込みで root を
 *   再計算して rootAnchored=true を返すこと。トークン改ざん / fingerprint 不一致 / 非アンカーの分岐。
 *
 * テスト鍵はファイル内で都度生成し options.registry でだけ注入する (グローバル registry に触れない)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  POSW_ITERATIONS,
  SESSION_TOKEN_FORMAT_VERSION,
  TypingProof,
  computeHash,
  createSessionStartToken,
  verifySessionStartToken,
  computeAnchoredChainRoot,
  verifyInitialHashRoot,
  type CheckpointPublicKey,
  type FingerprintComponents,
  type SessionStartToken,
} from '../index.js';
import { HashChainManager } from '../typingProof/HashChainManager.js';
import { createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Session Token Test)',
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
const ISSUED_AT = '2026-06-12T00:00:00.000Z';

async function makeToken(
  key: TestKey,
  overrides: { sessionId?: string; fingerprintHash?: string; serverNonce?: string; issuedAt?: string } = {}
): Promise<SessionStartToken> {
  return createSessionStartToken(
    {
      sessionId: overrides.sessionId ?? 'session-A',
      fingerprintHash: overrides.fingerprintHash ?? 'f'.repeat(64),
    },
    {
      serverNonce: overrides.serverNonce ?? SERVER_NONCE,
      issuedAt: overrides.issuedAt ?? ISSUED_AT,
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
}

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

describe('session start token (ADR-0017)', () => {
  it('verifySessionStartToken accepts a freshly signed token via the registry', async () => {
    const token = await makeToken(testKey);
    const result = await verifySessionStartToken(token, [testKey.registryEntry]);
    expect(result.valid).toBe(true);
    expect(result.keyId).toBe(testKey.keyId);
  });

  it('rejects a token whose keyId is not in the registry (no self-signed trust)', async () => {
    // 攻撃者が自分の鍵で署名し未登録 keyId を名乗っても、信頼アンカーは registry のみ。
    const token = await makeToken(testKey);
    const result = await verifySessionStartToken(token, []);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Unknown keyId/);
  });

  it('rejects a token whose payload was tampered after signing', async () => {
    const token = await makeToken(testKey);
    const tampered: SessionStartToken = {
      ...token,
      payload: { ...token.payload, serverNonce: 'b2'.repeat(32) },
    };
    const result = await verifySessionStartToken(tampered, [testKey.registryEntry]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature is invalid/);
  });

  it('rejects a token signed before the key validFrom', async () => {
    const token = await makeToken(testKey, { issuedAt: '2019-01-01T00:00:00.000Z' });
    // registry の validFrom は 2020-01-01。それより前の issuedAt は未来鍵扱いで拒否。
    const result = await verifySessionStartToken(token, [testKey.registryEntry]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/validFrom is after issuedAt/);
  });

  it('rejects a token signed at/after the key revokedAt', async () => {
    const token = await makeToken(testKey, { issuedAt: '2026-06-12T00:00:00.000Z' });
    const revoked: CheckpointPublicKey = {
      ...testKey.registryEntry,
      status: 'revoked',
      revokedAt: '2026-01-01T00:00:00.000Z',
    };
    const result = await verifySessionStartToken(token, [revoked]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/revoked at or before issuedAt/);
  });

  it('rejects a token with an unsupported version or poswIterations', async () => {
    const base = await makeToken(testKey);
    const badVersion: SessionStartToken = { ...base, payload: { ...base.payload, version: 99 as 1 } };
    expect((await verifySessionStartToken(badVersion, [testKey.registryEntry])).valid).toBe(false);
    const badPosw: SessionStartToken = { ...base, payload: { ...base.payload, poswIterations: 1 } };
    expect((await verifySessionStartToken(badPosw, [testKey.registryEntry])).valid).toBe(false);
  });

  it('uses the current SESSION_TOKEN_FORMAT_VERSION in created tokens', async () => {
    const token = await makeToken(testKey);
    expect(token.payload.version).toBe(SESSION_TOKEN_FORMAT_VERSION);
    expect(token.payload.poswIterations).toBe(POSW_ITERATIONS);
  });
});

describe('anchored chain root formula (ADR-0017)', () => {
  it('computeAnchoredChainRoot matches HashChainManager.generateAnchoredInitialHash for the same nonces', async () => {
    // generateAnchoredInitialHash は localNonce を内部生成するので、その nonce で再計算して一致を確認。
    const hcm = new HashChainManager();
    const fingerprintHash = 'c'.repeat(64);
    const generated = await hcm.generateAnchoredInitialHash(fingerprintHash, SERVER_NONCE);
    const recomputed = await computeAnchoredChainRoot(fingerprintHash, generated.nonce, SERVER_NONCE);
    expect(recomputed).toBe(generated.hash);
  });

  it('differs from the legacy unanchored root (serverNonce actually changes the root)', async () => {
    const fingerprintHash = 'c'.repeat(64);
    const localNonce = 'd'.repeat(64);
    const anchored = await computeAnchoredChainRoot(fingerprintHash, localNonce, SERVER_NONCE);
    const legacy = await computeHash(fingerprintHash + localNonce);
    expect(anchored).not.toBe(legacy);
  });
});

describe('verifyInitialHashRoot with session start token (ADR-0017)', () => {
  async function buildAnchoredProof(serverNonce: string, token: SessionStartToken) {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const proof = new TypingProof();
    await proof.initializeAnchored(fingerprintHash, components, serverNonce, token);
    let content = '';
    for (let i = 0; i < 3; i++) {
      const ch = String.fromCharCode('a'.charCodeAt(0) + i);
      await proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: ch, rangeOffset: content.length, rangeLength: 0 });
      content += ch;
    }
    const exported = await proof.exportProof(content);
    return { exported, fingerprintHash, content };
  }

  it('verifies a server-anchored root and reports rootAnchored=true', async () => {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const token = await makeToken(testKey, { fingerprintHash });
    const { exported } = await buildAnchoredProof(SERVER_NONCE, token);

    expect(exported.rootAnchored).toBe(true);
    expect(exported.sessionStartToken).toBeDefined();

    const result = await verifyInitialHashRoot(exported, {
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true);
    expect(result.rootAnchored).toBe(true);
  });

  it('fails when the embedded token is tampered (root no longer matches serverNonce)', async () => {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const token = await makeToken(testKey, { fingerprintHash });
    const { exported } = await buildAnchoredProof(SERVER_NONCE, token);

    // serverNonce を別物にすり替える (署名が壊れる)。
    exported.sessionStartToken = {
      ...exported.sessionStartToken!,
      payload: { ...exported.sessionStartToken!.payload, serverNonce: 'b2'.repeat(32) },
    };
    const result = await verifyInitialHashRoot(exported, {
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.rootAnchored).toBe(false);
    expect(result.reason).toMatch(/Session start token invalid/);
  });

  it('fails when the token fingerprintHash does not match the proof fingerprint', async () => {
    // buildAnchoredProof は proof の fingerprint を内部で確定する。トークンだけ別の fingerprint で
    // 署名させ、root の serverNonce が合っていても端末束縛 (token.fingerprintHash != proof fp) で弾くことを見る。
    const wrongToken = await makeToken(testKey, { fingerprintHash: '0'.repeat(64) });
    const { exported } = await buildAnchoredProof(SERVER_NONCE, wrongToken);
    const result = await verifyInitialHashRoot(exported, {
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/fingerprintHash does not match/);
  });

  it('reports rootAnchored=false for a legacy proof without a session start token', async () => {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const proof = new TypingProof();
    await proof.initialize(fingerprintHash, components); // 非アンカー (従来式)
    await proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: 'a', rangeOffset: 0, rangeLength: 0 });
    const exported = await proof.exportProof('a');

    expect(exported.rootAnchored).toBe(false);
    expect(exported.sessionStartToken).toBeUndefined();

    const result = await verifyInitialHashRoot(exported, {
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });
    expect(result.valid).toBe(true); // 旧式 root は依然 valid (後方互換)
    expect(result.rootAnchored).toBe(false);
  });
});
