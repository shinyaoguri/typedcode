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

/**
 * WebGL情報
 *
 * 全キーが optional なのは旧形式の proof (vendor / renderer / version /
 * shadingLanguageVersion も持つ) を読めるようにするため。新しい proof で集めるのは
 * `CollectedWebGLInfo` の範囲だけ (#242 / ADR-0044)。
 */
export interface WebGLInfo {
  vendor?: string;
  renderer?: string;
  version?: string;
  shadingLanguageVersion?: string;
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  error?: string;
}

/**
 * フィンガープリント構成要素 (proof に同梱される形)
 *
 * 旧形式の proof も受け付けるための型。新しい proof が集めるキーは
 * `CollectedFingerprintComponents` を参照。
 */
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
  /** 旧形式の proof にだけ存在する (canvas の描画結果)。新しい proof では集めない (#242 / ADR-0044) */
  canvas?: string;
  webgl: WebGLInfo;
  /** 旧形式の proof にだけ存在する (検出したフォントの一覧)。新しい proof では集めない (#242 / ADR-0044) */
  fonts?: string[];
  cookieEnabled: boolean;
  doNotTrack: string;
  maxTouchPoints: number;
}

/**
 * 新しい proof で集める WebGL 情報
 *
 * `WEBGL_debug_renderer_info` の 2 値だけ (ヘッドレス GPU の検出に使う)。
 * WebGL の context が取れないときは `error` だけを持つ。
 */
export type CollectedWebGLInfo = Pick<WebGLInfo, 'unmaskedVendor' | 'unmaskedRenderer' | 'error'>;

/**
 * 新しい proof で集めるフィンガープリント構成要素
 *
 * `Fingerprint.collectComponents()` の戻り値。canvas / fonts を持たず、webgl は
 * `CollectedWebGLInfo` に絞る。何を集めるかとその理由は ADR-0044 (#242)。
 * `FingerprintComponents` に代入できる (旧形式との互換を型でも保つ)。
 */
export type CollectedFingerprintComponents = Omit<FingerprintComponents, 'canvas' | 'fonts' | 'webgl'> & {
  webgl: CollectedWebGLInfo;
};

/** 詳細フィンガープリント情報 */
export interface DetailedFingerprint {
  hash: string;
  components: FingerprintComponents;
  timestamp: string;
}
