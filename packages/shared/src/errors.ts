/**
 * TypedCode カスタムエラークラス
 * エラーハンドリングの統一とエラー種別の識別を容易にする
 */

/**
 * TypedCode のベースエラークラス
 * すべてのカスタムエラーはこのクラスを継承する
 */
export class TypingProofError extends Error {
  constructor(
    message: string,
    public readonly code: TypingProofErrorCode
  ) {
    super(message);
    this.name = 'TypingProofError';
    // Error クラスの継承時に必要
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * エラーコード定義
 */
export type TypingProofErrorCode =
  // 初期化関連
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  // 検証関連
  | 'VERIFICATION_FAILED'
  | 'SEQUENCE_MISMATCH'
  | 'TIMESTAMP_VIOLATION'
  | 'HASH_MISMATCH'
  | 'PREVIOUS_HASH_MISMATCH'
  | 'POSW_VERIFICATION_FAILED'
  // イベント記録関連
  | 'RECORD_EVENT_FAILED'
  | 'ATTESTATION_FAILED'
  // Worker関連
  | 'WORKER_ERROR'
  | 'WORKER_TIMEOUT'
  // その他
  | 'UNKNOWN_ERROR';

/**
 * チェーン検証エラー
 * ハッシュ鎖の検証中に発生するエラー
 */
export class ChainVerificationError extends TypingProofError {
  constructor(
    message: string,
    code: TypingProofErrorCode,
    public readonly eventIndex?: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message, code);
    this.name = 'ChainVerificationError';
  }
}

/**
 * PoSW (Proof of Sequential Work) エラー
 * PoSW の計算・検証中に発生するエラー
 */
export class PoswError extends TypingProofError {
  constructor(
    message: string,
    code: TypingProofErrorCode = 'POSW_VERIFICATION_FAILED',
    public readonly details?: Record<string, unknown>
  ) {
    super(message, code);
    this.name = 'PoswError';
  }
}

/**
 * Worker エラー
 * Web Worker の通信・実行中に発生するエラー
 */
export class WorkerError extends TypingProofError {
  constructor(
    message: string,
    code: TypingProofErrorCode = 'WORKER_ERROR',
    public readonly originalError?: Error
  ) {
    super(message, code);
    this.name = 'WorkerError';
  }
}

/**
 * エラーがTypingProofErrorかどうかを判定
 */
export function isTypingProofError(error: unknown): error is TypingProofError {
  return error instanceof TypingProofError;
}

/**
 * エラーが特定のコードを持つかどうかを判定
 */
export function hasErrorCode(
  error: unknown,
  code: TypingProofErrorCode
): boolean {
  return isTypingProofError(error) && error.code === code;
}
