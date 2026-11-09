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

/**
 * casual/class/assignment のタブ作成時の認証 (Turnstile スクリプト読込 + チャレンジ + session/start)
 * の予算 (#375)。値は `PRE_EXPORT_VERIFICATION_BUDGET_MS` と同じ 15 秒だが、使う場所と打ち切った後の
 * 扱いが違うので名前を分ける。
 *
 * 超過したら表示中のチャレンジも打ち切り、失敗 attestation (`failureReason: 'timeout'`) を #0 に
 * 記録して非アンカー (`TypingProof.initialize`、`rootAnchored: false`) で編集を始める。token を得た後の
 * session/start は止めずに裏で待ち、遅れて届いた token は root にも proof にも入れず、署名専用 token
 * (`TabManager.signingOnlyToken`) として署名 cp の送信だけに使う (ADR-0017 / ADR-0027)。
 */
export const TAB_CREATE_VERIFICATION_BUDGET_MS = PRE_EXPORT_VERIFICATION_BUDGET_MS;

/**
 * 署名専用 token (ADR-0027) の再取得のバックオフ (#236。`services/SigningTokenRetry.ts`)。
 * 失敗 n 回目の後は `min(MAX, BASE·2^(n-1))` を上限とする `[上限/2, 上限]` の乱数だけ待つ
 * (5 → 10 → 20 → … → 300 秒で頭打ち)。上限の 5 分は「弱回線で大人数が同時に叩かない間隔」として
 * #236 で決めた値。
 */
export const SIGNING_TOKEN_RETRY_BASE_MS = 5_000;
export const SIGNING_TOKEN_RETRY_MAX_MS = 5 * 60_000;

/**
 * `online` イベントで再取得を早めるときに散らす窓 (#236)。教室の端末が同じ瞬間に online へ戻っても、
 * Turnstile + session/start をこの幅に一様に散らす (100 台で 1 秒あたり 7 本ほど)。
 */
export const SIGNING_TOKEN_ONLINE_JITTER_MS = 15_000;
