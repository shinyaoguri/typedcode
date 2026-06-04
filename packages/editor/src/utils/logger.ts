/**
 * 開発時のみ出力するデバッグログ。
 *
 * production ビルド (`import.meta.env.PROD`) では no-op になり、コンソールを
 * 汚さない。Vite が `import.meta.env.PROD` を静的に置換するため、production では
 * 呼び出しごと丸ごと dead-code として削れる。
 *
 * 方針:
 * - 情報/トレース目的の `console.log` は `debugLog` に置き換える
 * - 警告・エラーは本番でも見たいので `console.warn` / `console.error` を直接使う
 */
const isProd = Boolean(import.meta.env?.PROD);

export function debugLog(...args: unknown[]): void {
  if (!isProd) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}
