/**
 * Verification utility tests
 */

import { describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyCheckpoints,
  verifyContentReplay,
  verifyFinalChainHash,
  verifyInitialHashRoot,
  verifyProofMetadata,
} from '../index.js';
import type { ExportedProof, FingerprintComponents, ProofData, StoredEvent } from '../types.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Verification Test)',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'TestOS',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1,
  },
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  canvas: 'mock-canvas-fingerprint',
  webgl: {
    vendor: 'Mock Vendor',
    renderer: 'Mock Renderer',
  },
  fonts: ['Arial', 'Helvetica'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

describe('verification utilities', () => {
  it('verifies that the initial chain hash is bound to the fingerprint nonce', async () => {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const proof = new TypingProof();

    await proof.initialize(fingerprintHash, components);
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: 'a',
      rangeOffset: 0,
      rangeLength: 0,
    });

    const exported = await proof.exportProof('a');

    await expect(verifyInitialHashRoot(exported)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('rejects a tampered initial hash nonce', async () => {
    const components = createMockFingerprintComponents();
    const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
    const proof = new TypingProof();

    await proof.initialize(fingerprintHash, components);
    const exported = await proof.exportProof('');
    exported.typingProofData.initialHashNonce = '0'.repeat(64);

    await expect(verifyInitialHashRoot(exported)).resolves.toMatchObject({
      valid: false,
      reason: 'Initial event chain hash does not match fingerprint and nonce',
    });
  });

  it('replays content changes and rejects mismatched final content', () => {
    const events = [
      {
        type: 'contentChange',
        inputType: 'insertText',
        data: 'a',
        rangeOffset: 0,
        rangeLength: 0,
      },
      {
        type: 'contentChange',
        inputType: 'insertText',
        data: 'b',
        rangeOffset: 1,
        rangeLength: 0,
      },
    ] as StoredEvent[];

    expect(verifyContentReplay(events, 'ab')).toMatchObject({ valid: true });
    expect(verifyContentReplay(events, 'ba')).toMatchObject({
      valid: false,
      reason: 'Replayed content does not match exported final content',
    });
  });

  it('verifies exported final chain hash fields against the computed chain hash', () => {
    const proof = {
      typingProofData: {
        finalContentHash: 'content-hash',
        initialEventChainHash: 'root',
        finalEventChainHash: 'final',
        deviceId: 'device',
        metadata: {
          totalEvents: 1,
          pasteEvents: 0,
          internalPasteEvents: 0,
          dropEvents: 0,
          insertEvents: 1,
          deleteEvents: 0,
          totalTypingTime: 1,
          averageTypingSpeed: 1,
        },
      },
      proof: {
        totalEvents: 1,
        finalHash: 'final',
        startTime: 0,
        endTime: 1,
        signature: 'signature',
        events: [],
      },
    } as unknown as ExportedProof;

    expect(verifyFinalChainHash(proof, 'final')).toMatchObject({ valid: true });

    proof.proof.finalHash = 'tampered';
    expect(verifyFinalChainHash(proof, 'final')).toMatchObject({
      valid: false,
      reason: 'Signature final hash does not match verified chain hash',
    });
  });

  it('validates checkpoints against their referenced events', async () => {
    const event = {
      type: 'contentChange',
      inputType: 'insertText',
      data: 'a',
      hash: 'event-hash',
      timestamp: 12,
    } as StoredEvent;
    const contentHash = await computeHash('a');

    await expect(
      verifyCheckpoints([event], [
        { eventIndex: 0, hash: 'event-hash', timestamp: 12, contentHash },
      ])
    ).resolves.toMatchObject({ valid: true });

    await expect(
      verifyCheckpoints([event], [
        { eventIndex: 0, hash: 'tampered', timestamp: 12, contentHash },
      ])
    ).resolves.toMatchObject({
      valid: false,
      reason: 'Checkpoint hash mismatch at event 0',
    });
  });

  it('recomputes metadata from events and flags bulk insertText events', () => {
    const events = [
      {
        type: 'contentChange',
        inputType: 'insertText',
        data: 'ab',
        timestamp: 10,
      },
    ] as StoredEvent[];
    const proofData = {
      metadata: {
        totalEvents: 1,
        pasteEvents: 0,
        internalPasteEvents: 0,
        dropEvents: 0,
        insertEvents: 1,
        deleteEvents: 0,
        bulkInsertEvents: 1,
        totalTypingTime: 10,
        averageTypingSpeed: 0,
      },
    } as ProofData;

    expect(verifyProofMetadata(proofData, events)).toMatchObject({
      valid: true,
      isPureTyping: false,
      suspiciousBulkInsertEventIndexes: [0],
    });

    proofData.metadata.bulkInsertEvents = 0;
    expect(verifyProofMetadata(proofData, events)).toMatchObject({
      valid: false,
      reason: 'Proof metadata mismatch for bulkInsertEvents: expected 1, got 0',
    });
  });
});
