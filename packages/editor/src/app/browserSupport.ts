/**
 * 未対応ブラウザの判定 (#596)。
 *
 * E2E は Chromium でしか回していない (ADR-0033) ので、記録させるのは Chromium 系 (Chrome・Edge・Opera・
 * Brave など) だけにする。Safari (WebKit) と Firefox (Gecko) は、IME の composition イベントや画面共有の
 * `getSettings().displaySurface` の扱いなど、確かめていない経路で証明を記録させないために起動を止める。
 * Firefox を通したくなったら、nightly に Firefox の project を足してからここを外す。
 *
 * 見るのは UA 文字列だけ。偽装への耐性ではなく、利用者を対象のブラウザへ案内するための判定。
 * iOS のブラウザは Chrome (`CriOS`)・Edge (`EdgiOS`)・Firefox (`FxiOS`) も WebKit で動き、`Chrome/` や
 * `Firefox/` を名乗らないので WebKit として止まる。
 */

/** 止める理由 (エンジン)。`other` は Chromium も WebKit も Gecko も名乗らない UA */
export type UnsupportedBrowserReason = 'webkit' | 'firefox' | 'other';

/** Chromium 系なら `null`、それ以外は止める理由を返す。 */
export function detectUnsupportedBrowser(userAgent: string): UnsupportedBrowserReason | null {
  // `HeadlessChrome/` も含む。Edge (`Edg/`)・Opera (`OPR/`)・Samsung Internet なども `Chrome/` を併記する
  if (/Chrom(e|ium)\//.test(userAgent)) return null;
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/AppleWebKit\//.test(userAgent)) return 'webkit';
  return 'other';
}
