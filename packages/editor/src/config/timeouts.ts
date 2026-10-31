/**
 * Workers (Cloudflare) 呼び出しのタイムアウト定数 (#324)。
 *
 * 教室の不安定網や Workers の応答遅延で fetch が無応答のまま張り付くと、署名キューの
 * `flushing` が解除されず、session/start を待つタブ作成や best-effort のはずの export 前
 * 認証が無限に待たされる。応答が無いときは上限で諦め、既存の失敗経路 (リトライ・失敗
 * attestation) に合流させる。
 */

/** Workers への 1 回の fetch (verify-captcha / session/start / checkpoint/sign) の上限。 */
export const WORKERS_FETCH_TIMEOUT_MS = 10_000;

/**
 * best-effort モード (`capabilities.preExportBestEffort`: exam/class/assignment) での
 * export 前認証全体 (Turnstile スクリプト読込 + チャレンジ + 検証) の予算。
 * 超過したら失敗 attestation を記録して ZIP を出す。casual (best-effort でない) には適用しない。
 */
export const PRE_EXPORT_VERIFICATION_BUDGET_MS = 15_000;
