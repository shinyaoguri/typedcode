/**
 * Verification utility tests
 */

import { describe, expect, it } from 'vitest';
import {
  TypingProof,
  computeHash,
  verifyContentReplay,
  verifyFinalChainHash,
  verifyInitialHashRoot,
} from '../index.js';
import type { ExportedProof, FingerprintComponents, StoredEvent } from '../types.js';

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
});
