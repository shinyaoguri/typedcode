/**
 * Fingerprint クラスのテスト
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Fingerprint } from '../fingerprint.js';

describe('Fingerprint', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ==========================================================================
  // getDeviceId テスト
  // ==========================================================================

  describe('getDeviceId', () => {
    it('should generate new device ID if none exists', async () => {
      const deviceId = await Fingerprint.getDeviceId();

      // Should be a 64-character hex string (SHA-256)
      expect(deviceId).toMatch(/^[a-f0-9]{64}$/);

      // Should be stored in localStorage
      expect(localStorage.getItem(Fingerprint.STORAGE_KEY)).toBe(deviceId);
    });

    it('should return existing device ID from localStorage', async () => {
      const existingId = 'existing-device-id-12345';
      localStorage.setItem(Fingerprint.STORAGE_KEY, existingId);

      const deviceId = await Fingerprint.getDeviceId();
      expect(deviceId).toBe(existingId);
    });

    it('should persist generated device ID across calls', async () => {
      const firstCall = await Fingerprint.getDeviceId();
      const secondCall = await Fingerprint.getDeviceId();

      expect(firstCall).toBe(secondCall);
    });
  });

  // ==========================================================================
  // generateDeviceId テスト
  // ==========================================================================

  describe('generateDeviceId', () => {
    it('should generate unique IDs on each call', async () => {
      const id1 = await Fingerprint.generateDeviceId();
      const id2 = await Fingerprint.generateDeviceId();

      // Each call should produce a different ID (due to UUID and timestamp)
      expect(id1).not.toBe(id2);
    });

    it('should return a 64-character hex string', async () => {
      const id = await Fingerprint.generateDeviceId();

      expect(id).toHaveLength(64);
      expect(id).toMatch(/^[a-f0-9]+$/);
    });
  });

  // ==========================================================================
  // getStableInfo テスト
  // ==========================================================================

  describe('getStableInfo', () => {
    it('should return stable browser info', async () => {
      const info = await Fingerprint.getStableInfo();

      expect(info).toHaveProperty('userAgent');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('language');
      expect(info).toHaveProperty('hardwareConcurrency');
      expect(info).toHaveProperty('timezone');
      expect(info).toHaveProperty('webglVendor');
    });

    it('should return consistent info on multiple calls', async () => {
      const info1 = await Fingerprint.getStableInfo();
      const info2 = await Fingerprint.getStableInfo();

      expect(info1.userAgent).toBe(info2.userAgent);
      expect(info1.platform).toBe(info2.platform);
      expect(info1.language).toBe(info2.language);
    });
  });

  // ==========================================================================
  // getWebGLVendor テスト
  // ==========================================================================

  describe('getWebGLVendor', () => {
    it('should return a string', () => {
      const vendor = Fingerprint.getWebGLVendor();
      expect(typeof vendor).toBe('string');
    });

    it('should return vendor info or unknown', () => {
      const vendor = Fingerprint.getWebGLVendor();
      // Either returns mock value or 'unknown'
      expect(vendor.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // collectComponents テスト
  // ==========================================================================

  describe('collectComponents', () => {
    it('should collect all fingerprint components', async () => {
      const components = await Fingerprint.collectComponents();

      // Check all required properties exist
      expect(components).toHaveProperty('userAgent');
      expect(components).toHaveProperty('language');
      expect(components).toHaveProperty('languages');
      expect(components).toHaveProperty('platform');
      expect(components).toHaveProperty('hardwareConcurrency');
      expect(components).toHaveProperty('deviceMemory');
      expect(components).toHaveProperty('screen');
      expect(components).toHaveProperty('timezone');
      expect(components).toHaveProperty('timezoneOffset');
      expect(components).toHaveProperty('canvas');
      expect(components).toHaveProperty('webgl');
      expect(components).toHaveProperty('fonts');
      expect(components).toHaveProperty('cookieEnabled');
      expect(components).toHaveProperty('doNotTrack');
      expect(components).toHaveProperty('maxTouchPoints');
    });

    it('should return screen info with correct structure', async () => {
      const components = await Fingerprint.collectComponents();

      expect(components.screen).toHaveProperty('width');
      expect(components.screen).toHaveProperty('height');
      expect(components.screen).toHaveProperty('availWidth');
      expect(components.screen).toHaveProperty('availHeight');
      expect(components.screen).toHaveProperty('colorDepth');
      expect(components.screen).toHaveProperty('pixelDepth');
      expect(components.screen).toHaveProperty('devicePixelRatio');
    });

    it('should return numeric values for screen dimensions', async () => {
      const components = await Fingerprint.collectComponents();

      expect(typeof components.screen.width).toBe('number');
      expect(typeof components.screen.height).toBe('number');
      expect(typeof components.screen.devicePixelRatio).toBe('number');
    });
  });

  // ==========================================================================
  // generate テスト
  // ==========================================================================

  describe('generate', () => {
    it('should generate a 64-character hex hash', async () => {
      const hash = await Fingerprint.generate();

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should generate consistent hash for same environment', async () => {
      // In test environment with mocked values, should be consistent
      const hash1 = await Fingerprint.generate();
      const hash2 = await Fingerprint.generate();

      expect(hash1).toBe(hash2);
    });
  });

  // ==========================================================================
  // getCanvasFingerprint テスト
  // ==========================================================================

  describe('getCanvasFingerprint', () => {
    it('should return a data URL or error string', async () => {
      const fingerprint = await Fingerprint.getCanvasFingerprint();

      // Should return either data URL or 'canvas-error'
      expect(typeof fingerprint).toBe('string');
      expect(fingerprint.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // getWebGLFingerprint テスト
  // ==========================================================================

  describe('getWebGLFingerprint', () => {
    it('should return WebGL info object', () => {
      const info = Fingerprint.getWebGLFingerprint();

      expect(typeof info).toBe('object');
      // Should have either error or vendor/renderer
      expect(
        'error' in info || ('vendor' in info && 'renderer' in info)
      ).toBe(true);
    });
  });

  // ==========================================================================
  // getAvailableFonts テスト
  // ==========================================================================

  describe('getAvailableFonts', () => {
    it('should return an array', () => {
      const fonts = Fingerprint.getAvailableFonts();

      expect(Array.isArray(fonts)).toBe(true);
    });

    it('should return consistent fonts on multiple calls', () => {
      const fonts1 = Fingerprint.getAvailableFonts();
      const fonts2 = Fingerprint.getAvailableFonts();

      expect(fonts1).toEqual(fonts2);
    });
  });

  // ==========================================================================
  // getDetailedFingerprint テスト
  // ==========================================================================

  describe('getDetailedFingerprint', () => {
    it('should return detailed fingerprint with all fields', async () => {
      const detailed = await Fingerprint.getDetailedFingerprint();

      expect(detailed).toHaveProperty('hash');
      expect(detailed).toHaveProperty('components');
      expect(detailed).toHaveProperty('timestamp');

      expect(detailed.hash).toHaveLength(64);
      expect(detailed.components).toHaveProperty('userAgent');
      expect(detailed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ==========================================================================
  // STORAGE_KEY テスト
  // ==========================================================================

  describe('STORAGE_KEY', () => {
    it('should be the expected value', () => {
      expect(Fingerprint.STORAGE_KEY).toBe('typedcode-device-id');
    });
  });
});
