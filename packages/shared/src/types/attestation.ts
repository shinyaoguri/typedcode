/**
 * 人間認証関連の型定義
 */

/** 認証失敗の理由 */
export type VerificationFailureReason =
  | 'challenge_failed'
  | 'timeout'
  | 'network_error'
  | 'token_acquisition_failed';

/** 人間認証イベントデータ（Turnstile/reCAPTCHA結果） */
export interface HumanAttestationEventData {
  verified: boolean;      // 認証成功かどうか
  score: number;          // reCAPTCHAスコア（0.0-1.0）、Turnstileは常に1.0
  action: string;         // アクション名（'create_tab'など）
  timestamp: string;      // サーバータイムスタンプ（信頼できるアンカー）
  hostname: string;       // ホスト名
  signature: string;      // HMAC-SHA256署名（改ざん検出用）
  // 認証フロー結果（成功/失敗問わず記録）
  success: boolean;       // 認証フロー自体が成功したか
  failureReason?: VerificationFailureReason;  // 失敗時の理由
}

/** 利用規約同意データ */
export interface TermsAcceptedData {
  version: string;        // 規約バージョン
  timestamp: number;      // 同意時のタイムスタンプ（Date.now()）
  agreedAt: string;       // ISO 8601形式の日時文字列
}
