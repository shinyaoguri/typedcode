/**
 * shared ライブラリ用のデバッグログ。
 *
 * shared はブラウザ (Vite) と Node (verify-cli) の両方で動くため、`import.meta.env`
 * のような環境固有の gating が使えない。代わりにモジュールレベルのフラグで制御し、
 * **デフォルトは off** にして本番ビルド・CLI のコンソールを汚さない。
 *
 * 開発時にトレースを見たいホスト (editor の dev サーバなど) が起動時に
 * `setSharedDebug(true)` で有効化する。警告・エラーは本番でも見たいので
 * `console.warn` / `console.error` を直接使うこと。
 */
let enabled = false;

export function setSharedDebug(on: boolean): void {
  enabled = on;
}

export function isSharedDebugEnabled(): boolean {
  return enabled;
}

export function sharedDebugLog(...args: unknown[]): void {
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}
