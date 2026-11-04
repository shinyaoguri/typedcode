/**
 * verifySignedCheckpoints の拒否分岐を 1 つずつ固定する (#580)。
 *
 * payload を書き換えるだけの改ざんは署名検証か連鎖の検査で先に落ちるので、各検査そのものが
 * 効いているかは分からない (変異検査で生き残っていた)。ここでは resignCheckpoints で署名と
 * previousSignedCheckpointHash の連鎖を付け直し、「狙った 1 つの検査にだけ反する」cp 列を作る。
 * イベント列は合成 (makeSyntheticEvents)。署名 cp の検証は cp が指す event の hash 一致しか見ない。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { verifySignedCheckpoints, type CheckpointData, type SignedCheckpointEnvelope } from '../index.js';
import {
  buildSignedCheckpoints,
  createTestKey,
  makeSyntheticEvents,
  resignCheckpoints,
  type TestKey,
} from './fixtures/signedCheckpointFixtures.js';

const ROOT = 'a'.repeat(64);
const events = makeSyntheticEvents(3);

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

const build = (options: { eventIndexes?: number[]; serverStepMs?: number; key?: TestKey } = {}) =>
  buildSignedCheckpoints({ events, initialEventChainHash: ROOT, key: options.key ?? testKey, ...options });

const verify = (checkpoints: CheckpointData[], key: TestKey = testKey) =>
  verifySignedCheckpoints(events, checkpoints, ROOT, { registry: [key.registryEntry] });

describe('verifySignedCheckpoints: ordering of the signed chain', () => {
  it('rejects a checkpointIndex equal to the previous one even when signatures and chaining are intact', async () => {
    const checkpoints = await resignCheckpoints(await build(), testKey, (payload) => ({
      ...payload,
      checkpointIndex: 0,
    }));
    const result = await verify(checkpoints);
    expect(result.reason).toMatch(/checkpointIndex not strictly increasing/);
  });

  it('rejects two signed checkpoints pointing at the same event', async () => {
    const result = await verify(await build({ eventIndexes: [1, 1] }));
    expect(result.reason).toMatch(/eventIndex not strictly increasing/);
  });

  it('rejects a serverTimestamp equal to the previous one', async () => {
    const result = await verify(await build({ serverStepMs: 0 }));
    expect(result.reason).toMatch(/serverTimestamp not strictly increasing/);
  });
});

describe('verifySignedCheckpoints: timestamps that do not parse', () => {
  it('rejects a correctly signed checkpoint whose serverTimestamp is not a date', async () => {
    const checkpoints = await resignCheckpoints(await build(), testKey, (payload, i) =>
      i === 0 ? { ...payload, serverTimestamp: 'not-a-date' } : payload
    );
    const result = await verify(checkpoints);
    expect(result.reason).toMatch(/serverTimestamp is not a valid ISO date/);
  });

  it('rejects a correctly signed checkpoint whose clientTimestamp is not a date', async () => {
    const checkpoints = await resignCheckpoints(await build(), testKey, (payload, i) =>
      i === 0 ? { ...payload, clientTimestamp: 'not-a-date' } : payload
    );
    const result = await verify(checkpoints);
    expect(result.reason).toMatch(/clientTimestamp is not a valid ISO date/);
  });
});

describe('verifySignedCheckpoints: agreement with the enclosing checkpoint', () => {
  it('rejects a checkpoint whose contentHash disagrees with the signed payload', async () => {
    const checkpoints = await build();
    checkpoints[1]!.contentHash = 'f'.repeat(64);
    const result = await verify(checkpoints);
    expect(result.reason).toMatch(/contentHash disagrees with its enclosing CheckpointData\.contentHash/);
  });

  it('records the failing checkpoint as an invalid detail after the ones that passed', async () => {
    const checkpoints = await build();
    checkpoints[1]!.contentHash = 'f'.repeat(64);
    const result = await verify(checkpoints);
    expect(result.details[1]).toEqual({
      checkpointIndex: 1,
      eventIndex: 1,
      valid: false,
      reason: 'contentHash mismatch with enclosing checkpoint',
    });
  });
});

describe('verifySignedCheckpoints: signature envelope', () => {
  it('rejects an envelope whose algorithm label is not ECDSA-P256 even though the signature verifies', async () => {
    // algorithm は署名対象 (payload) の外にあるので、書き換えても ECDSA の検証自体は通る。
    const checkpoints = await build();
    checkpoints[0]!.signature = {
      ...checkpoints[0]!.signature!,
      algorithm: 'ES256' as SignedCheckpointEnvelope['algorithm'],
    };
    const result = await verify(checkpoints);
    expect(result.reason).toBe('Unsupported algorithm: ES256');
  });

  it('reports an odd-length signature as malformed hex rather than a failed verification', async () => {
    const checkpoints = await build();
    checkpoints[0]!.signature!.signature = 'abc';
    const result = await verify(checkpoints);
    expect(result.reason).toBe('Malformed signature hex');
  });
});

describe('verifySignedCheckpoints: registry key validity at serverTimestamp', () => {
  it('rejects a checkpoint signed before the key validFrom', async () => {
    const futureKey = await createTestKey({ validFrom: '2030-01-01T00:00:00Z' });
    const result = await verify(await build({ key: futureKey }), futureKey);
    expect(result.reason).toMatch(/validFrom is after serverTimestamp/);
  });

  it('rejects a checkpoint signed by a key marked revoked without revokedAt', async () => {
    const revokedKey = await createTestKey({ status: 'revoked' });
    const result = await verify(await build({ key: revokedKey }), revokedKey);
    expect(result.reason).toMatch(/status is 'revoked' but revokedAt is missing/);
  });

  it('does not attach the revoked-key warning to checkpoints signed by an active key', async () => {
    const result = await verify(await build());
    expect(result.details.map((d) => d.warning)).toEqual([undefined, undefined, undefined]);
  });
});

describe('verifySignedCheckpoints: auxiliary results on the failure paths', () => {
  it('reports no details when the proof has no signed checkpoints', async () => {
    const result = await verify([]);
    expect(result.details).toEqual([]);
  });

  it('measures no density, without throwing, when the only signed checkpoint points before the first event', async () => {
    const [first] = await build({ eventIndexes: [0] });
    const checkpoints = await resignCheckpoints([first!], testKey, (payload) => ({ ...payload, eventIndex: -1 }));
    const result = await verify(checkpoints);
    expect(result.density).toBeNull();
  });

  it('reports no temporal span when the first signed checkpoint already fails', async () => {
    const checkpoints = await resignCheckpoints(await build(), testKey, (payload, i) =>
      i === 0 ? { ...payload, version: 99 as 1 } : payload
    );
    const result = await verify(checkpoints);
    expect(result.temporal).toBeNull();
  });
});
