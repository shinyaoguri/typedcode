/**
 * 型ガード関数のテスト
 */

import { describe, it, expect } from 'vitest';
import { isMultiFileProof } from '../types.js';
import type {
  ExportedProof,
  MultiFileExportedProof,
  AnyExportedProof,
} from '../types.js';

describe('Type Guards', () => {
  // ==========================================================================
  // isMultiFileProof テスト
  // ==========================================================================

  describe('isMultiFileProof', () => {
    it('should return true for multi-file proof with type field', () => {
      const multiFileProof: MultiFileExportedProof = {
        version: '3.1.0',
        type: 'multi-file',
        fingerprint: {
          hash: 'test-hash',
          components: {
            userAgent: 'test',
            language: 'en',
            languages: ['en'],
            platform: 'test',
            hardwareConcurrency: 4,
            deviceMemory: 8,
            screen: {
              width: 1920,
              height: 1080,
              availWidth: 1920,
              availHeight: 1040,
              colorDepth: 24,
              pixelDepth: 24,
              devicePixelRatio: 1,
            },
            timezone: 'UTC',
            timezoneOffset: 0,
            canvas: 'canvas',
            webgl: { vendor: 'vendor' },
            fonts: [],
            cookieEnabled: true,
            doNotTrack: 'unknown',
            maxTouchPoints: 0,
          },
        },
        files: {},
        tabSwitches: [],
        metadata: {
          userAgent: 'test',
          timestamp: new Date().toISOString(),
          totalFiles: 0,
          overallPureTyping: true,
        },
      };

      expect(isMultiFileProof(multiFileProof)).toBe(true);
    });

    it('should return false for single-file proof without type field', () => {
      const singleProof = {
        version: '3.2.0',
        typingProofHash: 'hash',
        typingProofData: {
          finalContentHash: 'hash',
          finalEventChainHash: 'hash',
          deviceId: 'device',
          metadata: {
            totalEvents: 0,
            pasteEvents: 0,
            dropEvents: 0,
            insertEvents: 0,
            deleteEvents: 0,
            totalTypingTime: 0,
            averageTypingSpeed: 0,
          },
        },
        proof: {
          totalEvents: 0,
          finalHash: 'hash',
          startTime: 0,
          endTime: 0,
          signature: 'sig',
          events: [],
        },
        fingerprint: {
          hash: 'test-hash',
          components: {
            userAgent: 'test',
            language: 'en',
            languages: ['en'],
            platform: 'test',
            hardwareConcurrency: 4,
            deviceMemory: 8,
            screen: {
              width: 1920,
              height: 1080,
              availWidth: 1920,
              availHeight: 1040,
              colorDepth: 24,
              pixelDepth: 24,
              devicePixelRatio: 1,
            },
            timezone: 'UTC',
            timezoneOffset: 0,
            canvas: 'canvas',
            webgl: { vendor: 'vendor' },
            fonts: [],
            cookieEnabled: true,
            doNotTrack: 'unknown',
            maxTouchPoints: 0,
          },
        },
        metadata: {
          userAgent: 'test',
          timestamp: new Date().toISOString(),
          isPureTyping: true,
        },
        checkpoints: [],
      } as unknown as ExportedProof;

      expect(isMultiFileProof(singleProof)).toBe(false);
    });

    it('should return false for object with different type value', () => {
      const wrongType = {
        type: 'single-file',
        files: {},
      } as unknown as AnyExportedProof;

      expect(isMultiFileProof(wrongType)).toBe(false);
    });

    it('should return false for object without type field', () => {
      const noType = {
        version: '3.2.0',
        typingProofHash: 'hash',
      } as unknown as AnyExportedProof;

      expect(isMultiFileProof(noType)).toBe(false);
    });

    it('should correctly narrow the type', () => {
      const proof: AnyExportedProof = {
        version: '3.1.0',
        type: 'multi-file',
        fingerprint: {
          hash: 'test',
          components: {} as MultiFileExportedProof['fingerprint']['components'],
        },
        files: { 'test.c': {} as MultiFileExportedProof['files'][string] },
        tabSwitches: [],
        metadata: {
          userAgent: 'test',
          timestamp: new Date().toISOString(),
          totalFiles: 1,
          overallPureTyping: true,
        },
      } as MultiFileExportedProof;

      if (isMultiFileProof(proof)) {
        // TypeScript should recognize proof as MultiFileExportedProof
        expect(proof.files).toBeDefined();
        expect(proof.tabSwitches).toBeDefined();
        expect(proof.metadata.totalFiles).toBe(1);
      } else {
        // This should not be reached
        expect.fail('isMultiFileProof should return true');
      }
    });
  });
});
