/**
 * フィンガープリント関連の型定義
 */

/** 画面情報 */
export interface ScreenInfo {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
}

/** WebGL情報 */
export interface WebGLInfo {
  vendor?: string;
  renderer?: string;
  version?: string;
  shadingLanguageVersion?: string;
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  error?: string;
}

/** フィンガープリント構成要素 */
export interface FingerprintComponents {
  userAgent: string;
  language: string;
  languages: readonly string[];
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screen: ScreenInfo;
  timezone: string;
  timezoneOffset: number;
  canvas: string;
  webgl: WebGLInfo;
  fonts: string[];
  cookieEnabled: boolean;
  doNotTrack: string;
  maxTouchPoints: number;
}

/** 安定したブラウザ情報 */
export interface StableInfo {
  userAgent: string;
  platform: string;
  language: string;
  hardwareConcurrency: number;
  timezone: string;
  webglVendor: string;
}

/** 詳細フィンガープリント情報 */
export interface DetailedFingerprint {
  hash: string;
  components: FingerprintComponents;
  timestamp: string;
}
