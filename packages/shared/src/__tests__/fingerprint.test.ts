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
  // collectComponents テスト
  // ==========================================================================

  describe('collectComponents', () => {
    it('collects exactly the 13 components kept by ADR-0044 and nothing else (no canvas, no fonts)', async () => {
      const components = await Fingerprint.collectComponents();

      expect(Object.keys(components).sort()).toEqual([
        'cookieEnabled',
        'deviceMemory',
        'doNotTrack',
        'hardwareConcurrency',
        'language',
        'languages',
        'maxTouchPoints',
        'platform',
        'screen',
        'timezone',
        'timezoneOffset',
        'userAgent',
        'webgl',
      ]);
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
  // getWebGLFingerprint テスト
  // ==========================================================================

  describe('getWebGLFingerprint', () => {
    // setup.ts の既定モック (getExtension は null) を、ケースごとに差し替えて必ず戻す
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    afterEach(() => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    });

    /** WEBGL_debug_renderer_info を持つ WebGL context を返すようにする */
    const stubWebGLWithDebugRendererInfo = (): void => {
      const UNMASKED_VENDOR_WEBGL = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;
      const gl = {
        VENDOR: 0x1f00,
        RENDERER: 0x1f01,
        VERSION: 0x1f02,
        SHADING_LANGUAGE_VERSION: 0x8b8c,
        getParameter: (param: number) => {
          switch (param) {
            case UNMASKED_VENDOR_WEBGL:
              return 'Real GPU Vendor';
            case UNMASKED_RENDERER_WEBGL:
              return 'Real GPU Renderer';
            default:
              return 'masked value';
          }
        },
        getExtension: (name: string) =>
          name === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL } : null,
      };
      HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
        contextId === 'webgl' || contextId === 'experimental-webgl'
          ? gl
          : null) as typeof HTMLCanvasElement.prototype.getContext;
    };

    it("reports 'unknown' for both unmasked values when WEBGL_debug_renderer_info is unavailable", () => {
      expect(Fingerprint.getWebGLFingerprint()).toEqual({ unmaskedVendor: 'unknown', unmaskedRenderer: 'unknown' });
    });

    it('returns only the unmasked vendor and renderer when WEBGL_debug_renderer_info is available', () => {
      stubWebGLWithDebugRendererInfo();

      expect(Fingerprint.getWebGLFingerprint()).toEqual({
        unmaskedVendor: 'Real GPU Vendor',
        unmaskedRenderer: 'Real GPU Renderer',
      });
    });

    it('returns an error marker when no WebGL context is available', () => {
      HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

      expect(Fingerprint.getWebGLFingerprint()).toEqual({ error: 'WebGL not supported' });
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
  // データ最小化 (#412)
  // ==========================================================================

  describe('storage writes', () => {
    it('does not write any typedcode- key to localStorage when collecting or hashing the fingerprint', async () => {
      await Fingerprint.collectComponents();
      await Fingerprint.generate();
      await Fingerprint.getDetailedFingerprint();

      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
      expect(keys.filter((k) => k?.startsWith('typedcode-'))).toEqual([]);
    });
  });
});
