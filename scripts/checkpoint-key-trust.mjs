/**
 * verify (Web) のビルドが staging の checkpoint 鍵を時刻証拠に数えるかを、ビルド時の環境変数から決める (#321)。
 *
 * verify の vite.config.ts が環境変数 `TYPEDCODE_TRUST_STAGING_KEYS` を渡して呼び、結果を define
 * (`__TYPEDCODE_TRUST_STAGING_KEYS__`) でバンドルに焼く。`.github/workflows/deploy.yml` は staging と PR プレビューの
 * ビルドでだけ `true` を渡し、production のビルドと CI の検査のビルドには渡さない。
 *
 * - 未指定・空・空白だけ → false (既定。本番の verify は staging の鍵を信頼しない)
 * - `true` → true
 * - `false` → false
 * - それ以外 → throw (綴りの誤りで黙って本番と同じ扱いにしない。ビルドを止める)
 */

/**
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
export function resolveTrustStagingKeys(value) {
  const raw = (value ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(
    `TYPEDCODE_TRUST_STAGING_KEYS の値 ${JSON.stringify(value)} は true / false のどちらでもない (staging のビルドでだけ true を渡す)`
  );
}
