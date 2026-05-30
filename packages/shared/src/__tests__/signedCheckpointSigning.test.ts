/**
 * Phase 3 サーバ側 signing 関数のテスト。
 *
 * `createSignedCheckpointEnvelope` が:
 * - validateSignedCheckpointInput の出力で動作し
 * - 出力 envelope が verifyCheckpointSignature で検証可能
 * - serverTimestamp / firstSeenAt の挿入位置が正しい
 * - 同じ入力 → 異なる serverContext は異なる payload / 異なる signature
 *
 * Workers package には test setup が無いため、shared 側で round-trip テストを行う。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  SIGNED_CHECKPOINT_FORMAT_VERSION,
  POSW_ITERATIONS,
  createSignedCheckpointEnvelope,
  validateSignedCheckpointInput,
  verifyCheckpointSignature,
} from '../index.js';
import { createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const baseInputRaw = {
  sessionId: 'session-1',
  tabId: 'tab-1',
  checkpointIndex: 0,
  eventIndex: 32,
  initialEventChainHash: 'a'.repeat(64),
  chainHash: 'b'.repeat(64),
  contentHash: 'c'.repeat(64),
  previousSignedCheckpointHash: null,
  totalEventsSincePrevious: 33,
  clientTimestamp: '2026-05-28T12:00:00.000Z',
};

let key: TestKey;

beforeAll(async () => {
  key = await createTestKey();
});

describe('validateSignedCheckpointInput', () => {
  it('accepts a fully-formed input', () => {
    const r = validateSignedCheckpointInput(baseInputRaw);
    expect(r.ok).toBe(true);
  });

  it('rejects missing sessionId', () => {
    const r = validateSignedCheckpointInput({ ...baseInputRaw, sessionId: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects negative eventIndex', () => {
    const r = validateSignedCheckpointInput({ ...baseInputRaw, eventIndex: -1 });
    expect(r.ok).toBe(false);
  });

  it('rejects non-integer checkpointIndex', () => {
    const r = validateSignedCheckpointInput({ ...baseInputRaw, checkpointIndex: 1.5 });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed previousSignedCheckpointHash', () => {
    const r = validateSignedCheckpointInput({
      ...baseInputRaw,
      previousSignedCheckpointHash: 'not-hex',
    });
    expect(r.ok).toBe(false);
  });

  it('accepts null previousSignedCheckpointHash', () => {
    const r = validateSignedCheckpointInput({
      ...baseInputRaw,
      previousSignedCheckpointHash: null,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects invalid ISO clientTimestamp', () => {
    const r = validateSignedCheckpointInput({
      ...baseInputRaw,
      clientTimestamp: 'not-iso',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateSignedCheckpointInput(null).ok).toBe(false);
    expect(validateSignedCheckpointInput(42).ok).toBe(false);
    expect(validateSignedCheckpointInput('string').ok).toBe(false);
  });
});

describe('createSignedCheckpointEnvelope', () => {
  it('bakes server-supplied fields into the payload', async () => {
    const v = validateSignedCheckpointInput(baseInputRaw);
    if (!v.ok) throw new Error('input invalid');
    const envelope = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:01.234Z', firstSeenAt: '2026-05-28T12:00:00.500Z' },
      { keyId: key.keyId, privateKey: key.privateKey }
    );
    expect(envelope.payload.version).toBe(SIGNED_CHECKPOINT_FORMAT_VERSION);
    expect(envelope.payload.poswIterations).toBe(POSW_ITERATIONS);
    expect(envelope.payload.serverTimestamp).toBe('2026-05-28T12:00:01.234Z');
    expect(envelope.payload.firstSeenAt).toBe('2026-05-28T12:00:00.500Z');
    expect(envelope.payload.clientTimestamp).toBe(baseInputRaw.clientTimestamp);
    expect(envelope.algorithm).toBe('ECDSA-P256');
    expect(envelope.keyId).toBe(key.keyId);
    expect(envelope.signature).toMatch(/^[0-9a-f]+$/);
  });

  it('produces a signature that verifyCheckpointSignature accepts', async () => {
    const v = validateSignedCheckpointInput(baseInputRaw);
    if (!v.ok) throw new Error('input invalid');
    const envelope = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:01.000Z', firstSeenAt: '2026-05-28T12:00:00.500Z' },
      { keyId: key.keyId, privateKey: key.privateKey }
    );
    const verified = await verifyCheckpointSignature(envelope, [key.registryEntry]);
    expect(verified.valid).toBe(true);
  });

  it('rejects when the signature is verified with a different key', async () => {
    const v = validateSignedCheckpointInput(baseInputRaw);
    if (!v.ok) throw new Error('input invalid');
    const envelope = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:01.000Z', firstSeenAt: '2026-05-28T12:00:00.500Z' },
      { keyId: key.keyId, privateKey: key.privateKey }
    );
    const otherKey = await createTestKey({ keyId: key.keyId });
    const verified = await verifyCheckpointSignature(envelope, [otherKey.registryEntry]);
    expect(verified.valid).toBe(false);
  });

  it('different serverTimestamp produces a different signature', async () => {
    const v = validateSignedCheckpointInput(baseInputRaw);
    if (!v.ok) throw new Error('input invalid');
    const a = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:01.000Z', firstSeenAt: '2026-05-28T12:00:00.000Z' },
      { keyId: key.keyId, privateKey: key.privateKey }
    );
    const b = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:02.000Z', firstSeenAt: '2026-05-28T12:00:00.000Z' },
      { keyId: key.keyId, privateKey: key.privateKey }
    );
    expect(a.signature).not.toBe(b.signature);
  });

  it('embeds the public key when signer requests it', async () => {
    const v = validateSignedCheckpointInput(baseInputRaw);
    if (!v.ok) throw new Error('input invalid');
    const envelope = await createSignedCheckpointEnvelope(
      v.input,
      { serverTimestamp: '2026-05-28T12:00:01.000Z', firstSeenAt: '2026-05-28T12:00:00.000Z' },
      {
        keyId: key.keyId,
        privateKey: key.privateKey,
        publicKeyJwk: key.publicKeyJwk,
        publicKeyValidFrom: '2025-01-01T00:00:00.000Z',
      }
    );
    expect(envelope.publicKeyJwk).toEqual(key.publicKeyJwk);
    expect(envelope.publicKeyValidFrom).toBe('2025-01-01T00:00:00.000Z');
  });
});
