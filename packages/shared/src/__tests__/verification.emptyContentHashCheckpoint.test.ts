/**
 * 削除イベントに乗った未署名 cp を、署名済み cp が前後で挟む proof を検証器が受け入れる (#571)。
 *
 * editor の `SignedCheckpointService` は contentHash が空の cp (data の無いイベントに乗った cp) を
 * 署名に回さない。その結果 proof には「署名 cp → 削除の未署名 cp (contentHash: '') → 署名 cp」の並びが
 * 出る。署名 cp の checkpointIndex は署名した cp だけの通し番号、totalEventsSincePrevious は最後に
 * 署名した cp からの件数、previousSignedCheckpointHash は直前の署名 cp の payload hash になる
 * (`buildSignedCheckpoints` に署名する eventIndex だけを渡すと、この規則どおりに組み上がる)。
 * proof の形式と検証器は変えていないので、この並びがそのまま valid であることを固定する。
 *
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
} from '../index.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

const SESSION_ID = 'session-571';
const SERVER_NONCE = 'b2'.repeat(32);

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (Empty contentHash Checkpoint Test)',
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
};

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

/**
 * [挿入 'a', 挿入 'b', 削除, 挿入 'c'] を記録した anchored proof に、削除の前後の挿入だけを署名した
 * cp と、削除に乗った未署名 cp (contentHash: '') を載せる。
 */
async function buildProofWithUnsignedDeletionCheckpoint() {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await createSessionStartToken(
    { sessionId: SESSION_ID, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: '2026-06-12T00:00:00.000Z',
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: testKey.keyId, privateKey: testKey.privateKey }
  );

  const typingProof = new TypingProof();
  await typingProof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  const insert = async (ch: string, offset: number) =>
    typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: offset,
      rangeLength: 0,
    });
  await insert('a', 0);
  await insert('b', 1);
  await typingProof.recordEvent({
    type: 'contentChange',
    inputType: 'deleteContentBackward',
    data: '',
    rangeOffset: 1,
    rangeLength: 1,
  });
  await insert('c', 1);
  const content = 'ac';

  const exported = await typingProof.exportProof(content);
  const events = exported.proof.events;
  const deletionIndex = events.findIndex((e) => e.inputType === 'deleteContentBackward');
  const beforeIndex = deletionIndex - 1;
  const afterIndex = deletionIndex + 1;

  const signed = await buildSignedCheckpoints({
    events,
    initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
    key: testKey,
    sessionId: SESSION_ID,
    eventIndexes: [beforeIndex, afterIndex],
  });
  const deletionEvent = events[deletionIndex]!;
  // CheckpointManager.createCheckpoint が data の無いイベントに作る形 (contentHash: '')
  const unsignedDeletion: CheckpointData = {
    eventIndex: deletionIndex,
    hash: deletionEvent.hash,
    timestamp: deletionEvent.timestamp,
    contentHash: '',
  };
  const checkpoints = [signed[0]!, unsignedDeletion, signed[1]!];
  return { ...exported, checkpoints, content, language: 'text', deletionIndex };
}

describe('verifyProofFile: unsigned deletion checkpoint between signed checkpoints (#571)', () => {
  it('builds signed checkpoints that number only signed ones and count events from the last signed one', async () => {
    const proofFile = await buildProofWithUnsignedDeletionCheckpoint();
    const [first, , second] = proofFile.checkpoints;

    expect(proofFile.checkpoints[1]!.signature).toBeUndefined();
    expect(proofFile.checkpoints[1]!.contentHash).toBe('');
    expect(first!.signature!.payload.checkpointIndex).toBe(0);
    expect(second!.signature!.payload.checkpointIndex).toBe(1);
    expect(second!.signature!.payload.totalEventsSincePrevious).toBe(2);
    expect(second!.signature!.payload.previousSignedCheckpointHash).not.toBeNull();
  });

  it('accepts a proof whose deletion checkpoint is left unsigned between two signed checkpoints', async () => {
    const proofFile = await buildProofWithUnsignedDeletionCheckpoint();
    const result = await verifyProofFile(proofFile, undefined, {
      mode: 'fast',
      signedCheckpointKeyRegistry: [testKey.registryEntry],
    });

    expect(result.valid).toBe(true);
    expect(result.signedCheckpoints?.valid).toBe(true);
  });
});
