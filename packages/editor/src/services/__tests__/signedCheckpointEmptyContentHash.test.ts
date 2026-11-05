/**
 * data の無いイベントに乗った cp (contentHash が空文字) を署名に回さない (#571)。
 *
 * `CheckpointManager.createCheckpoint` は `event.data` が falsy なら `contentHash: ''` の cp を作る
 * (削除の contentChange は `data: ''`)。署名 API の入力検査 `validateSignedCheckpointInput` は
 * 64 桁 hex を要求するので、Workers はこの cp を 400 `SCHEMA_INVALID` で拒否する。
 * `SignedCheckpointService` は eventIndex 昇順で 1 件ずつ署名するので、かつてはこの cp で詰まって
 * 後続の cp の署名まで止まっていた。今は enqueue の時点で飛ばす。
 *
 * fetch は Workers と同じく body を `validateSignedCheckpointInput` に通し、失敗なら 400 を返す。
 * cp は `createCheckpoint` を直接呼んで作るので、時刻に依存しない。
 */

import { describe, expect, it, vi } from 'vitest';
import { SignedCheckpointService } from '../SignedCheckpointService.js';
import {
  POSW_ITERATIONS,
  validateSignedCheckpointInput,
  type CheckpointData,
  type SessionStartToken,
  type SignedCheckpointEnvelope,
  type SignedCheckpointInput,
  type StoredEvent,
} from '@typedcode/shared';
// CheckpointManager / HashChainManager は shared の index から出していないので src を直に読む
// (verify の webCliParity.test.ts と同じ流儀)
import { CheckpointManager } from '../../../../shared/src/typingProof/CheckpointManager.js';
import { HashChainManager } from '../../../../shared/src/typingProof/HashChainManager.js';

const SESSION = 'session-571';
const TAB = 'tab-571';
const INITIAL_HASH = 'a'.repeat(64);
const FIRST_SEEN_AT = '2026-11-05T00:00:00.000Z';

function makeToken(sessionId = SESSION): SessionStartToken {
  return {
    payload: { sessionId },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SessionStartToken;
}

/** 署名 API が受け取った input をそのまま写した envelope (firstSeenAt は固定)。 */
function makeEnvelope(input: SignedCheckpointInput): SignedCheckpointEnvelope {
  return {
    payload: {
      version: 1,
      ...input,
      poswIterations: POSW_ITERATIONS,
      serverTimestamp: '2026-11-05T00:00:01.000Z',
      firstSeenAt: FIRST_SEEN_AT,
    },
    signature: 'sig',
    keyId: 'test-key',
    algorithm: 'ECDSA-P256',
  } as unknown as SignedCheckpointEnvelope;
}

/** hash は eventIndex を 64 桁に詰めた hex (列の中で一意)。 */
function makeEvent(index: number, inputType: 'insertText' | 'deleteContentBackward', data: string): StoredEvent {
  return {
    sequence: index,
    timestamp: (index + 1) * 1000,
    type: 'contentChange',
    inputType,
    data,
    rangeOffset: 0,
    rangeLength: inputType === 'deleteContentBackward' ? 1 : 0,
    range: null,
    previousHash: null,
    posw: { iterations: POSW_ITERATIONS, nonce: '0', intermediateHash: '0', computeTimeMs: 0 },
    hash: (index + 1).toString(16).padStart(64, '0'),
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  };
}

function makeCheckpointManager(): CheckpointManager {
  return new CheckpointManager(new HashChainManager(), { now: () => 0 });
}

/** 実物の CheckpointManager で、削除イベント (data: '') に乗った cp を作る。 */
async function createDeletionCheckpoint(): Promise<CheckpointData> {
  const manager = makeCheckpointManager();
  const events = [makeEvent(0, 'deleteContentBackward', '')];
  await manager.createCheckpoint(0, events);
  return manager.getLastCheckpoint()!;
}

/**
 * Workers の /api/checkpoint/sign を真似た fetch。body を validateSignedCheckpointInput に通し、
 * 失敗なら 400 SCHEMA_INVALID、成功なら payload を写した envelope を返す。
 */
function createSigningApi() {
  const bodies: Record<string, unknown>[] = [];
  const statuses: number[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const validated = validateSignedCheckpointInput(body);
    if (!validated.ok) {
      statuses.push(400);
      return {
        ok: false,
        status: 400,
        json: async () => ({ code: 'SCHEMA_INVALID', error: validated.reason }),
      } as unknown as Response;
    }
    statuses.push(200);
    return {
      ok: true,
      status: 200,
      json: async () => ({ envelope: makeEnvelope(validated.input) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, statuses };
}

function createService(attachSignature: (eventIndex: number, envelope: SignedCheckpointEnvelope) => boolean) {
  const api = createSigningApi();
  const service = new SignedCheckpointService({
    apiUrl: 'http://localhost:9999',
    sessionId: SESSION,
    tabId: TAB,
    getInitialEventChainHash: () => INITIAL_HASH,
    getSessionStartToken: () => makeToken(),
    attachSignature,
    isOnline: () => true,
    fetchImpl: api.fetchImpl,
    backoffSchedule: [1],
    // 本番の既定 (backoff 最大 60 秒 × 10 回) では拒否される cp が数分居座る。それを再現するため、
    // テストの待ち時間の中では捨てられない回数にしておく。
    maxAttemptsPerCheckpoint: 10_000,
  });
  return { service, ...api };
}

/**
 * [挿入, 削除 (data: ''), 挿入] の 3 イベントそれぞれに実物の CheckpointManager で cp を作り、
 * onCheckpointCreated フック経由で SignedCheckpointService へ流す。
 */
async function runInsertDeleteInsert() {
  const manager = makeCheckpointManager();
  const attached: number[] = [];
  const { service, fetchImpl, bodies, statuses } = createService((eventIndex, envelope) => {
    attached.push(eventIndex);
    return manager.updateSignature(eventIndex, envelope);
  });
  manager.setOnCheckpointCreated((cp) => service.handleNewCheckpoint(cp));

  const events = [
    makeEvent(0, 'insertText', 'a'),
    makeEvent(1, 'deleteContentBackward', ''),
    makeEvent(2, 'insertText', 'b'),
  ];
  for (let i = 0; i < events.length; i++) {
    await manager.createCheckpoint(i, events);
  }
  await service.waitForFlush(1500);
  return { manager, service, fetchImpl, bodies, statuses, attached };
}

describe('empty contentHash checkpoint precondition (#571)', () => {
  it('a checkpoint on an event without data has an empty contentHash that the signing API input validation rejects', async () => {
    const cp = await createDeletionCheckpoint();
    expect(cp.contentHash).toBe('');

    const input: SignedCheckpointInput = {
      sessionId: SESSION,
      tabId: TAB,
      checkpointIndex: 0,
      eventIndex: cp.eventIndex,
      initialEventChainHash: INITIAL_HASH,
      chainHash: cp.hash,
      contentHash: cp.contentHash,
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 1,
      clientTimestamp: '2026-11-05T00:00:00.000Z',
    };
    const result = validateSignedCheckpointInput(input);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('contentHash');
  });
});

describe('SignedCheckpointService skips checkpoints with an empty contentHash (#571)', () => {
  it('never sends a sign request for a new checkpoint whose contentHash is empty', async () => {
    const { service, fetchImpl } = createService(() => true);
    service.handleNewCheckpoint(await createDeletionCheckpoint());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
    service.dispose();
  });

  it('never receives a 400 from the signing API when a deletion checkpoint sits between insertions', async () => {
    const { service, statuses } = await runInsertDeleteInsert();

    expect(statuses).not.toContain(400);
    service.dispose();
  });

  it('signs the checkpoints on both sides of a deletion checkpoint and drains the queue', async () => {
    const { service, attached, manager } = await runInsertDeleteInsert();

    expect(attached).toEqual([0, 2]);
    expect(manager.getCheckpoints().map((cp) => cp.signature !== undefined)).toEqual([true, false, true]);
    expect(service.pendingCount()).toBe(0);
    service.dispose();
  });

  it('chains the signed checkpoint after a deletion directly to the last signed one', async () => {
    const { service, bodies } = await runInsertDeleteInsert();

    const second = bodies.find((b) => b.eventIndex === 2);
    expect(second).toBeDefined();
    expect(second!.checkpointIndex).toBe(1);
    expect(second!.totalEventsSincePrevious).toBe(2);
    expect(second!.previousSignedCheckpointHash).not.toBeNull();
    service.dispose();
  });

  it('does not re-enqueue a restored unsigned checkpoint whose contentHash is empty', async () => {
    const { service, fetchImpl } = createService(() => true);
    await service.restore([await createDeletionCheckpoint()]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
    service.dispose();
  });

  it('signs a later checkpoint after restoring an unsigned checkpoint whose contentHash is empty', async () => {
    const attached: number[] = [];
    const { service, statuses } = createService((eventIndex) => {
      attached.push(eventIndex);
      return true;
    });
    await service.restore([await createDeletionCheckpoint()]);

    const manager = makeCheckpointManager();
    const events = [makeEvent(0, 'deleteContentBackward', ''), makeEvent(1, 'insertText', 'a')];
    await manager.createCheckpoint(1, events);
    service.handleNewCheckpoint(manager.getLastCheckpoint()!);
    await service.waitForFlush(1500);

    expect(attached).toEqual([1]);
    expect(statuses).toEqual([200]);
    service.dispose();
  });
});
