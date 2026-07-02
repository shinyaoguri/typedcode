/**
 * exportProof のスナップショット一貫性 (#143) のテスト。
 *
 * export 中も記録は続きうる (スクショ/visibility の broadcast 等)。署名・メタデータ・
 * checkpoint が別々の時点の events を見ると「同梱 events に無い eventIndex を指す
 * checkpoint」や totalEvents 不一致の proof ができ、verifier で丸ごと invalid になる。
 */

import { describe, expect, it } from 'vitest';
import { TypingProof, computeHash, verifyProofMetadata, verifyCheckpoints } from '../index.js';
import type { FingerprintComponents } from '../types.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (ExportSnapshot Test)',
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

async function buildProof(chars: string): Promise<{ proof: TypingProof; content: string }> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);
  let content = '';
  for (const ch of chars) {
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  return { proof, content };
}

describe('exportProof snapshot consistency (#143)', () => {
  it('never exports a checkpoint pointing beyond the exported events', async () => {
    const { proof, content } = await buildProof('abc');
    // export 中に別イベントの checkpoint が作られた状況を再現: 同梱 events (3 件) の
    // 範囲外を指す checkpoint を注入する (checkpoints アクセサは内部配列を返す)。
    proof.checkpoints.push({
      eventIndex: 10,
      hash: 'f'.repeat(64),
      timestamp: 999,
      contentHash: '',
    });

    const exported = await proof.exportProof(content);
    const maxIndex = exported.proof.events.length - 1;
    for (const cp of exported.checkpoints ?? []) {
      expect(cp.eventIndex).toBeLessThanOrEqual(maxIndex);
    }
    // 同梱 events に対する checkpoint 検証が通る (範囲外 cp が残ると即 fail する層)
    await expect(
      verifyCheckpoints(exported.proof.events, exported.checkpoints)
    ).resolves.toMatchObject({ valid: true });
  });

  it('creates the final checkpoint at the last exported event', async () => {
    const { proof, content } = await buildProof('ab');
    const exported = await proof.exportProof(content);
    const last = exported.proof.events.length - 1;
    expect((exported.checkpoints ?? []).some((cp) => cp.eventIndex === last)).toBe(true);
  });

  it('keeps signature totalEvents / finalHash and metadata consistent with the exported events', async () => {
    const { proof, content } = await buildProof('abc');
    const exported = await proof.exportProof(content);
    expect(exported.proof.totalEvents).toBe(exported.proof.events.length);
    expect(exported.proof.finalHash).toBe(
      exported.proof.events[exported.proof.events.length - 1]!.hash
    );
    // メタデータ再カウント (verifyProofMetadata) が同梱 events と一致する
    expect(
      verifyProofMetadata(exported.typingProofData, exported.proof.events)
    ).toMatchObject({ valid: true });
  });

  it('waitForQueueDrain resolves once all recorded events are on the chain', async () => {
    const { proof } = await buildProof('a');
    await expect(proof.waitForQueueDrain(1000)).resolves.toBe(true);
  });
});
