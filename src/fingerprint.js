/**
 * Fingerprint - ブラウザフィンガープリント生成
 * 端末とブラウザの固有情報を収集して識別子を生成
 */

export class Fingerprint {
  static STORAGE_KEY = 'typedcode-device-id';

  /**
   * 永続的なデバイスIDを取得または生成
   * @returns {Promise<string>} デバイスID（ハッシュ）
   */
  static async getDeviceId() {
    // LocalStorageから既存のIDを取得
    const existingId = localStorage.getItem(this.STORAGE_KEY);
    if (existingId) {
      console.log('[Fingerprint] Using existing device ID');
      return existingId;
    }

    // 新しいIDを生成
    console.log('[Fingerprint] Generating new device ID');
    const deviceId = await this.generateDeviceId();
    localStorage.setItem(this.STORAGE_KEY, deviceId);
    return deviceId;
  }

  /**
   * 新しいデバイスIDを生成
   * @returns {Promise<string>} デバイスIDハッシュ
   */
  static async generateDeviceId() {
    // ランダムUUID + タイムスタンプ + 安定したブラウザ情報
    const uuid = crypto.randomUUID();
    const timestamp = Date.now();
    const stableInfo = await this.getStableInfo();

    const combined = `${uuid}-${timestamp}-${JSON.stringify(stableInfo)}`;

    // SHA-256でハッシュ化
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
  }

  /**
   * 比較的安定したブラウザ情報を取得
   * @returns {Object} 安定した情報のみ
   */
  static async getStableInfo() {
    return {
      // これらは比較的安定している
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

      // WebGLベンダー情報（比較的安定）
      webglVendor: this.getWebGLVendor()
    };
  }

  /**
   * WebGLベンダー情報のみ取得（安定した情報）
   */
  static getWebGLVendor() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'unknown';

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        return gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      }
      return gl.getParameter(gl.VENDOR);
    } catch (e) {
      return 'unknown';
    }
  }

  /**
   * ブラウザフィンガープリントを生成（詳細情報用）
   * @returns {Promise<string>} フィンガープリントハッシュ
   */
  static async generate() {
    const components = await this.collectComponents();
    const fingerprintString = JSON.stringify(components, null, 0);

    // SHA-256でハッシュ化
    const encoder = new TextEncoder();
    const data = encoder.encode(fingerprintString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
  }

  /**
   * フィンガープリント構成要素を収集
   * @returns {Promise<Object>} フィンガープリント構成要素
   */
  static async collectComponents() {
    const components = {
      // 基本情報
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages || [],
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
      deviceMemory: navigator.deviceMemory || 0,

      // 画面情報
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        devicePixelRatio: window.devicePixelRatio || 1
      },

      // タイムゾーン
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),

      // Canvas fingerprint
      canvas: await this.getCanvasFingerprint(),

      // WebGL fingerprint
      webgl: this.getWebGLFingerprint(),

      // フォント情報
      fonts: this.getAvailableFonts(),

      // その他
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack || 'unknown',
      maxTouchPoints: navigator.maxTouchPoints || 0
    };

    return components;
  }

  /**
   * Canvas フィンガープリントを生成
   * @returns {Promise<string>} Canvas データURL
   */
  static async getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 50;
      const ctx = canvas.getContext('2d');

      // テキストを描画（フォントレンダリングの違いを検出）
      ctx.textBaseline = 'top';
      ctx.font = '14px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('TypedCode 🔒', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('TypedCode 🔒', 4, 17);

      // Canvas を base64 に変換
      return canvas.toDataURL();
    } catch (e) {
      return 'canvas-error';
    }
  }

  /**
   * WebGL フィンガープリントを取得
   * @returns {Object} WebGL情報
   */
  static getWebGLFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');

      if (!gl) {
        return { error: 'WebGL not supported' };
      }

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

      return {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'unknown',
        unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown'
      };
    } catch (e) {
      return { error: 'WebGL error' };
    }
  }

  /**
   * 利用可能なフォントを検出
   * @returns {Array<string>} フォント名の配列
   */
  static getAvailableFonts() {
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const testFonts = [
      'Arial', 'Verdana', 'Times New Roman', 'Courier New',
      'Georgia', 'Palatino', 'Garamond', 'Bookman',
      'Comic Sans MS', 'Trebuchet MS', 'Impact',
      'Helvetica', 'Lucida Console', 'Monaco',
      'Consolas', 'Menlo', 'MS Gothic', 'Yu Gothic'
    ];

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const testString = 'mmmmmmmmmmlli';
    const testSize = '72px';

    // ベースフォントの幅を測定
    const baseWidths = {};
    baseFonts.forEach(baseFont => {
      ctx.font = `${testSize} ${baseFont}`;
      baseWidths[baseFont] = ctx.measureText(testString).width;
    });

    // テストフォントが利用可能かチェック
    const availableFonts = [];
    testFonts.forEach(font => {
      let detected = false;
      baseFonts.forEach(baseFont => {
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
   * @returns {Promise<Object>} 詳細なフィンガープリント情報
   */
  static async getDetailedFingerprint() {
    const components = await this.collectComponents();
    const hash = await this.generate();

    return {
      hash,
      components,
      timestamp: new Date().toISOString()
    };
  }
}
