/**
 * TypingProof クラスのテスト
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TypingProof } from '../typingProof.js';
import type { FingerprintComponents, InputType } from '../types.js';

// テスト用のモックFingerprintComponents
const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Test)',
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

describe('TypingProof', () => {
  // ==========================================================================
  // P0: 純粋関数テスト（副作用なし）
  // ==========================================================================

  describe('isAllowedInputType', () => {
    const proof = new TypingProof();

    const allowedTypes: InputType[] = [
      'insertText',
      'insertLineBreak',
      'insertParagraph',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
      'deleteByDrag',
      'historyUndo',
      'historyRedo',
      'insertCompositionText',
      'deleteCompositionText',
      'insertFromComposition',
    ];

    it.each(allowedTypes)('should return true for allowed type: %s', (type) => {
      expect(proof.isAllowedInputType(type)).toBe(true);
    });

    const notAllowedTypes: InputType[] = [
      'insertFromPaste',
      'insertFromDrop',
      'insertFromYank',
      'insertReplacementText',
      'insertFromPasteAsQuotation',
      'insertTab',
      'deleteByCut',
      'replaceContent',
    ];

    it.each(notAllowedTypes)('should return false for non-allowed type: %s', (type) => {
      expect(proof.isAllowedInputType(type)).toBe(false);
    });
  });

  describe('isProhibitedInputType', () => {
    const proof = new TypingProof();

    const prohibitedTypes: InputType[] = [
      'insertFromPaste',
      'insertFromDrop',
      'insertFromYank',
      'insertReplacementText',
      'insertFromPasteAsQuotation',
    ];

    it.each(prohibitedTypes)('should return true for prohibited type: %s', (type) => {
      expect(proof.isProhibitedInputType(type)).toBe(true);
    });

    const notProhibitedTypes: InputType[] = [
      'insertText',
      'deleteContentBackward',
      'historyUndo',
      'insertTab',
    ];

    it.each(notProhibitedTypes)('should return false for non-prohibited type: %s', (type) => {
      expect(proof.isProhibitedInputType(type)).toBe(false);
    });
  });

  // ==========================================================================
  // P0: ユーティリティ関数テスト
  // ==========================================================================

  describe('arrayBufferToHex', () => {
    const proof = new TypingProof();

    it('should convert Uint8Array to hex string', () => {
      const input = new Uint8Array([0, 1, 15, 16, 255]);
      expect(proof.arrayBufferToHex(input)).toBe('00010f10ff');
    });

    it('should handle empty array', () => {
      expect(proof.arrayBufferToHex(new Uint8Array([]))).toBe('');
    });

    it('should handle ArrayBuffer', () => {
      const buffer = new Uint8Array([170, 187, 204]).buffer;
      expect(proof.arrayBufferToHex(buffer)).toBe('aabbcc');
    });

    it('should pad single digit hex values with zero', () => {
      const input = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(proof.arrayBufferToHex(input)).toBe('000102030405060708090a0b0c0d0e0f');
    });
  });

  // ==========================================================================
  // P1: ハッシュ計算テスト（crypto.subtle依存）
  // ==========================================================================

  describe('computeHash', () => {
    const proof = new TypingProof();

    it('should compute SHA-256 hash of "test"', async () => {
      const result = await proof.computeHash('test');
      // SHA-256 of "test" is a known value
      expect(result).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    });

    it('should compute SHA-256 hash of empty string', async () => {
      const result = await proof.computeHash('');
      // SHA-256 of "" is a known value
      expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should produce different hashes for different inputs', async () => {
      const hash1 = await proof.computeHash('input1');
      const hash2 = await proof.computeHash('input2');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce consistent hash for same input', async () => {
      const hash1 = await proof.computeHash('consistent-input');
      const hash2 = await proof.computeHash('consistent-input');
      expect(hash1).toBe(hash2);
    });

    it('should produce 64 character hex string', async () => {
      const result = await proof.computeHash('any input');
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[a-f0-9]+$/);
    });
  });

  // ==========================================================================
  // P1: 決定的JSON変換テスト（private メソッド）
  // ==========================================================================

  describe('deterministicStringify', () => {
    it('should produce same output regardless of key order', async () => {
      const proof = new TypingProof();
      // @ts-expect-error: accessing private method for testing
      const stringify = proof.deterministicStringify.bind(proof);

      const obj1 = { b: 1, a: 2, c: 3 };
      const obj2 = { a: 2, c: 3, b: 1 };
      const obj3 = { c: 3, b: 1, a: 2 };

      expect(stringify(obj1)).toBe(stringify(obj2));
      expect(stringify(obj2)).toBe(stringify(obj3));
    });

    it('should handle nested objects with sorted keys', async () => {
      const proof = new TypingProof();
      // @ts-expect-error: accessing private method for testing
      const stringify = proof.deterministicStringify.bind(proof);

      const nested = { z: { b: 1, a: 2 }, a: 1 };
      const result = stringify(nested);
      expect(result).toBe('{"a":1,"z":{"a":2,"b":1}}');
    });

    it('should handle arrays without sorting', async () => {
      const proof = new TypingProof();
      // @ts-expect-error: accessing private method for testing
      const stringify = proof.deterministicStringify.bind(proof);

      const withArray = { items: [3, 1, 2], name: 'test' };
      const result = stringify(withArray);
      expect(result).toBe('{"items":[3,1,2],"name":"test"}');
    });

    it('should handle null and undefined', async () => {
      const proof = new TypingProof();
      // @ts-expect-error: accessing private method for testing
      const stringify = proof.deterministicStringify.bind(proof);

      expect(stringify(null)).toBe('null');
      expect(stringify({ a: null })).toBe('{"a":null}');
    });
  });

  // ==========================================================================
  // P2: 初期化テスト
  // ==========================================================================

  describe('initialize', () => {
    it('should initialize with fingerprint and set initialized flag', async () => {
      const proof = new TypingProof();
      const mockComponents = createMockFingerprintComponents();

      expect(proof.initialized).toBe(false);
      expect(proof.fingerprint).toBeNull();

      await proof.initialize('test-fingerprint-hash', mockComponents);

      expect(proof.initialized).toBe(true);
      expect(proof.fingerprint).toBe('test-fingerprint-hash');
      expect(proof.fingerprintComponents).toEqual(mockComponents);
      expect(proof.currentHash).not.toBeNull();
    });

    it('should generate initial hash based on fingerprint', async () => {
      const proof1 = new TypingProof();
      const proof2 = new TypingProof();
      const mockComponents = createMockFingerprintComponents();

      await proof1.initialize('fingerprint-a', mockComponents);
      await proof2.initialize('fingerprint-b', mockComponents);

      // Different fingerprints should produce different initial hashes
      // (though randomness is involved, so they should just not be null)
      expect(proof1.currentHash).not.toBeNull();
      expect(proof2.currentHash).not.toBeNull();
    });
  });

  // ==========================================================================
  // P2: イベント記録テスト
  // ==========================================================================

  describe('recordEvent', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should throw error if not initialized', async () => {
      const uninitializedProof = new TypingProof();
      await expect(
        uninitializedProof.recordEvent({ type: 'contentChange', data: 'x' })
      ).rejects.toThrow('not initialized');
    });

    it('should record event and update hash chain', async () => {
      const initialHash = proof.currentHash;

      const result = await proof.recordEvent({
        type: 'contentChange',
        inputType: 'insertText',
        data: 'a',
      });

      expect(result.index).toBe(0);
      expect(result.hash).not.toBe(initialHash);
      expect(proof.events.length).toBe(1);
      expect(proof.currentHash).toBe(result.hash);
    });

    it('should maintain sequence order', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'a' });
      await proof.recordEvent({ type: 'contentChange', data: 'b' });
      await proof.recordEvent({ type: 'contentChange', data: 'c' });

      expect(proof.events[0]?.sequence).toBe(0);
      expect(proof.events[1]?.sequence).toBe(1);
      expect(proof.events[2]?.sequence).toBe(2);
    });

    it('should maintain hash chain integrity', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'first' });
      const firstEventHash = proof.events[0]?.hash;

      await proof.recordEvent({ type: 'contentChange', data: 'second' });

      // Second event's previousHash should be first event's hash
      expect(proof.events[1]?.previousHash).toBe(firstEventHash);
    });

    it('should handle concurrent calls with queue', async () => {
      // Record multiple events concurrently
      const promises = [
        proof.recordEvent({ type: 'contentChange', data: '1' }),
        proof.recordEvent({ type: 'contentChange', data: '2' }),
        proof.recordEvent({ type: 'contentChange', data: '3' }),
      ];

      const results = await Promise.all(promises);

      expect(results[0]?.index).toBe(0);
      expect(results[1]?.index).toBe(1);
      expect(results[2]?.index).toBe(2);
      expect(proof.events.length).toBe(3);
    });
  });

  // ==========================================================================
  // P2: 人間認証テスト
  // ==========================================================================

  describe('recordHumanAttestation', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should record human attestation as event #0', async () => {
      const attestation = {
        score: 0.9,
        action: 'create_file',
        token: 'mock-token',
        timestamp: Date.now(),
      };

      const result = await proof.recordHumanAttestation(attestation);

      expect(result.index).toBe(0);
      expect(proof.events[0]?.type).toBe('humanAttestation');
      expect(proof.hasHumanAttestation()).toBe(true);
    });

    it('should throw error if events already exist', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'x' });

      const attestation = {
        score: 0.9,
        action: 'create_file',
        token: 'mock-token',
        timestamp: Date.now(),
      };

      await expect(proof.recordHumanAttestation(attestation)).rejects.toThrow(
        'must be event #0'
      );
    });
  });

  describe('hasHumanAttestation', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should return false when no events', () => {
      expect(proof.hasHumanAttestation()).toBe(false);
    });

    it('should return true when first event is humanAttestation', async () => {
      await proof.recordHumanAttestation({
        score: 0.9,
        action: 'test',
        token: 'token',
        timestamp: Date.now(),
      });

      expect(proof.hasHumanAttestation()).toBe(true);
    });

    it('should return false when first event is not humanAttestation', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'x' });

      expect(proof.hasHumanAttestation()).toBe(false);
    });
  });

  // ==========================================================================
  // P2: 検証テスト
  // ==========================================================================

  describe('verify', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should verify empty chain', async () => {
      const result = await proof.verify();
      expect(result.valid).toBe(true);
    });

    it('should verify single event chain', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'test' });

      const result = await proof.verify();
      expect(result.valid).toBe(true);
    });

    it('should verify multiple events chain', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'a' });
      await proof.recordEvent({ type: 'contentChange', data: 'b' });
      await proof.recordEvent({ type: 'contentChange', data: 'c' });

      const result = await proof.verify();
      expect(result.valid).toBe(true);
      expect(result.message).toContain('verified successfully');
    });

    it('should call progress callback', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'a' });
      await proof.recordEvent({ type: 'contentChange', data: 'b' });

      const progressCalls: number[] = [];
      await proof.verify((current, total) => {
        progressCalls.push(current);
        expect(total).toBe(2);
      });

      expect(progressCalls).toContain(1);
      expect(progressCalls).toContain(2);
    });
  });

  // ==========================================================================
  // P3: 統計テスト
  // ==========================================================================

  describe('getStats', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should return initial stats', () => {
      const stats = proof.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.currentHash).not.toBeNull();
      expect(stats.pendingCount).toBe(0);
    });

    it('should update stats after events', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'a' });
      await proof.recordEvent({ type: 'keyDown', data: { key: 'a' } });

      const stats = proof.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.eventTypes.contentChange).toBe(1);
      expect(stats.eventTypes.keyDown).toBe(1);
    });
  });

  describe('getTypingStatistics', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should count paste and drop events', async () => {
      await proof.recordEvent({ type: 'contentChange', inputType: 'insertText', data: 'a' });
      await proof.recordEvent({ type: 'contentChange', inputType: 'insertFromPaste', data: 'pasted' });
      await proof.recordEvent({ type: 'contentChange', inputType: 'insertFromDrop', data: 'dropped' });
      await proof.recordEvent({ type: 'contentChange', inputType: 'deleteContentBackward' });

      const stats = proof.getTypingStatistics();
      expect(stats.totalEvents).toBe(4);
      expect(stats.pasteEvents).toBe(1);
      expect(stats.dropEvents).toBe(1);
      expect(stats.deleteEvents).toBe(1);
    });
  });

  // ==========================================================================
  // P3: リセットテスト
  // ==========================================================================

  describe('reset', () => {
    let proof: TypingProof;

    beforeEach(async () => {
      proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
    });

    it('should clear all events and reset hash', async () => {
      await proof.recordEvent({ type: 'contentChange', data: 'a' });
      await proof.recordEvent({ type: 'contentChange', data: 'b' });

      expect(proof.events.length).toBe(2);

      await proof.reset();

      expect(proof.events.length).toBe(0);
      expect(proof.checkpoints.length).toBe(0);
      expect(proof.currentHash).not.toBeNull();
    });
  });

  // ==========================================================================
  // P3: シリアライズ/デシリアライズテスト
  // ==========================================================================

  describe('serializeState / restoreState', () => {
    it('should serialize and restore state', async () => {
      const proof = new TypingProof();
      await proof.initialize('test-fingerprint', createMockFingerprintComponents());
      await proof.recordEvent({ type: 'contentChange', data: 'test' });

      const serialized = proof.serializeState();

      expect(serialized.events).toHaveLength(1);
      expect(serialized.currentHash).toBe(proof.currentHash);

      const newProof = new TypingProof();
      newProof.restoreState(serialized);

      expect(newProof.events).toHaveLength(1);
      expect(newProof.currentHash).toBe(serialized.currentHash);
    });
  });

  describe('fromSerializedState', () => {
    it('should create new instance from serialized state', async () => {
      const original = new TypingProof();
      const mockComponents = createMockFingerprintComponents();
      await original.initialize('test-fingerprint', mockComponents);
      await original.recordEvent({ type: 'contentChange', data: 'test' });

      const serialized = original.serializeState();

      const restored = await TypingProof.fromSerializedState(
        serialized,
        'test-fingerprint',
        mockComponents
      );

      expect(restored.initialized).toBe(true);
      expect(restored.events).toHaveLength(1);
      expect(restored.currentHash).toBe(serialized.currentHash);
      expect(restored.fingerprint).toBe('test-fingerprint');
    });
  });
});
