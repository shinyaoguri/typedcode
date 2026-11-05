/**
 * Fingerprint - ブラウザ環境情報のハッシュ
 * proof に同梱するブラウザ環境情報を集め、その SHA-256 を端末の照合用の値にする
 */

import type { CollectedFingerprintComponents, CollectedWebGLInfo, DetailedFingerprint, ScreenInfo } from './types.js';
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
   *
   * 集めるのは 13 キーだけ (canvas の描画結果とフォント一覧は集めず、WebGL は
   * unmasked の vendor / renderer の 2 値)。各キーを残す理由は
   * docs/adr/0044-fingerprint-collection-scope.md (#242)。
   */
  static async collectComponents(): Promise<CollectedFingerprintComponents> {
    const screenInfo: ScreenInfo = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio ?? 1,
    };

    const components: CollectedFingerprintComponents = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages ?? [],
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      deviceMemory: navigator.deviceMemory ?? 0,
      screen: screenInfo,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      webgl: this.getWebGLFingerprint(),
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack ?? 'unknown',
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    };

    return components;
  }

  /**
   * WebGL の unmasked vendor / renderer を取得 (ヘッドレス GPU の検出に使う)
   *
   * `WEBGL_debug_renderer_info` が無ければ各 `'unknown'`。context が取れなければ `error` だけを返す。
   */
  static getWebGLFingerprint(): CollectedWebGLInfo {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl') ?? (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

      if (!gl) {
        return { error: 'WebGL not supported' };
      }

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

      return {
        unmaskedVendor: debugInfo ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string) : 'unknown',
        unmaskedRenderer: debugInfo ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string) : 'unknown',
      };
    } catch {
      return { error: 'WebGL error' };
    }
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
