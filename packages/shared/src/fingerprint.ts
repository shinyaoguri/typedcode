/**
 * Fingerprint - ブラウザフィンガープリント生成
 * 端末とブラウザの固有情報を収集して識別子を生成
 */

import type { FingerprintComponents, ScreenInfo, WebGLInfo, DetailedFingerprint } from './types.js';
import { computeHash } from './utils/hashUtils.js';

export class Fingerprint {
  /**
   * ブラウザフィンガープリントを生成（詳細情報用）
   */
  static async generate(): Promise<string> {
    const components = await this.collectComponents();
    const fingerprintString = JSON.stringify(components, null, 0);
    return computeHash(fingerprintString);
  }

  /**
   * フィンガープリント構成要素を収集
   */
  static async collectComponents(): Promise<FingerprintComponents> {
    const screenInfo: ScreenInfo = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio ?? 1,
    };

    const components: FingerprintComponents = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages ?? [],
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      deviceMemory: navigator.deviceMemory ?? 0,
      screen: screenInfo,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      canvas: await this.getCanvasFingerprint(),
      webgl: this.getWebGLFingerprint(),
      fonts: this.getAvailableFonts(),
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack ?? 'unknown',
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    };

    return components;
  }

  /**
   * Canvas フィンガープリントを生成
   */
  static async getCanvasFingerprint(): Promise<string> {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 50;
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'canvas-error';

      ctx.textBaseline = 'top';
      ctx.font = '14px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('TypedCode', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('TypedCode', 4, 17);

      return canvas.toDataURL();
    } catch {
      return 'canvas-error';
    }
  }

  /**
   * WebGL フィンガープリントを取得
   */
  static getWebGLFingerprint(): WebGLInfo {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl') ?? (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

      if (!gl) {
        return { error: 'WebGL not supported' };
      }

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

      return {
        vendor: gl.getParameter(gl.VENDOR) as string,
        renderer: gl.getParameter(gl.RENDERER) as string,
        version: gl.getParameter(gl.VERSION) as string,
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION) as string,
        unmaskedVendor: debugInfo ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string) : 'unknown',
        unmaskedRenderer: debugInfo ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string) : 'unknown',
      };
    } catch {
      return { error: 'WebGL error' };
    }
  }

  /**
   * 利用可能なフォントを検出
   */
  static getAvailableFonts(): string[] {
    const baseFonts = ['monospace', 'sans-serif', 'serif'] as const;
    const testFonts = [
      'Arial',
      'Verdana',
      'Times New Roman',
      'Courier New',
      'Georgia',
      'Palatino',
      'Garamond',
      'Bookman',
      'Comic Sans MS',
      'Trebuchet MS',
      'Impact',
      'Helvetica',
      'Lucida Console',
      'Monaco',
      'Consolas',
      'Menlo',
      'MS Gothic',
      'Yu Gothic',
    ];

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    const testString = 'mmmmmmmmmmlli';
    const testSize = '72px';

    const baseWidths: Record<string, number> = {};
    baseFonts.forEach((baseFont) => {
      ctx.font = `${testSize} ${baseFont}`;
      baseWidths[baseFont] = ctx.measureText(testString).width;
    });

    const availableFonts: string[] = [];
    testFonts.forEach((font) => {
      let detected = false;
      baseFonts.forEach((baseFont) => {
        ctx.font = `${testSize} '${font}', ${baseFont}`;
        const width = ctx.measureText(testString).width;
        if (width !== baseWidths[baseFont]) {
          detected = true;
        }
      });
      if (detected) {
        availableFonts.push(font);
      }
    });

    return availableFonts;
  }

  /**
   * フィンガープリント情報を人間が読める形式で取得
   */
  static async getDetailedFingerprint(): Promise<DetailedFingerprint> {
    const components = await this.collectComponents();
    const hash = await this.generate();

    return {
      hash,
      components,
      timestamp: new Date().toISOString(),
    };
  }
}
