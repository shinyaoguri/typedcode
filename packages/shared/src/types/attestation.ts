/**
 * 人間認証関連の型定義
 */

/** 認証失敗の理由 */
export type VerificationFailureReason = 'challenge_failed' | 'timeout' | 'network_error' | 'token_acquisition_failed';

/** 人間認証イベントデータ（Turnstile/reCAPTCHA結果） */
export interface HumanAttestationEventData {
  verified: boolean; // 認証成功かどうか
  score: number; // reCAPTCHAスコア（0.0-1.0）、Turnstileは常に1.0
  action: string; // アクション名（'create_tab'など）
  timestamp: string; // サーバータイムスタンプ（信頼できるアンカー）
  hostname: string; // ホスト名
  /**
   * 署名の印。暗号的な検証には使わない (検証器はこの値を読まない)。
   * - 新しい export 前 attestation (`preExportAttestation`) は `'unsigned'` (#415 で署名をやめた)
   * - 作成時の #0 (session/start 経由) は `session-start-token:<keyId>` (束縛は proof 同梱の sessionStartToken が担う。ADR-0017)
   * - best-effort の失敗記録は `''`
   * - 旧い proof には HMAC-SHA256 の 16 進値が入っている (legacy。読むが検証しない)。型を string のままにして旧 proof を読めるようにする
   */
  signature: string;
  // 認証フロー結果（成功/失敗問わず記録）
  success: boolean; // 認証フロー自体が成功したか
  failureReason?: VerificationFailureReason; // 失敗時の理由
}

/** 利用規約同意データ */
export interface TermsAcceptedData {
  version: string; // 規約バージョン
  timestamp: number; // 同意時のタイムスタンプ（Date.now()）
  agreedAt: string; // ISO 8601形式の日時文字列
}
