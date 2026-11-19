/**
 * About に出すアプリの版を、ビルドに渡した版 (タグ名) とコミットから決める (#842 / ADR-0055 の決定 3)。
 *
 * editor / verify の vite.config.ts が、環境変数 `TYPEDCODE_VERSION` と `git rev-parse --short HEAD`
 * の結果を渡して呼ぶ。ルートの package.json の `version` は読まない (リリースがファイルを変えないため)。
 *
 * - 版が `v?X.Y.Z` か `v?X.Y.Z-beta.N` なら、先頭の `v` を除いて返す (`v2027.2.0-beta.3` → `2027.2.0-beta.3`)
 * - 版が無い (未指定・空・空白だけ) なら `dev+<コミット>`。コミットも分からなければ `dev`
 * - 版が空でないのに形に合わなければ throw する (崩れた版を About に出さず、ビルドを止める)
 */

/** ビルドに渡してよい版の形。タグ名 (`v` 付き) もそのまま受け付ける。 */
export const APP_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(-beta\.\d+)?$/;

/**
 * @param {{ version?: string | null, commit?: string | null }} input
 * @returns {string}
 */
export function resolveAppVersion({ version, commit } = {}) {
  const raw = (version ?? '').trim();
  if (raw === '') {
    const sha = (commit ?? '').trim();
    return sha === '' || sha === 'unknown' ? 'dev' : `dev+${sha}`;
  }
  if (!APP_VERSION_PATTERN.test(raw)) {
    throw new Error(
      `TYPEDCODE_VERSION の値 ${JSON.stringify(version)} は版の形に合わない (期待する形: vX.Y.Z または vX.Y.Z-beta.N。先頭の v は省略可)`
    );
  }
  return raw.replace(/^v/, '');
}
