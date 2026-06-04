/**
 * Signed checkpoint 型定義 (browser/DOM 非依存).
 *
 * これらの型は Cloudflare Workers / Node tooling からも import されるため、
 * 他の types/* ファイルに依存しない独立した型ファイルにしている。
 */

/** 署名対象の payload */
export interface SignedCheckpointPayload {
  version: 1;
  sessionId: string;
  tabId: string;
  checkpointIndex: number;
  eventIndex: number;
  initialEventChainHash: string;
  chainHash: string;
  contentHash: string;
  previousSignedCheckpointHash: string | null;
  totalEventsSincePrevious: number;
  poswIterations: number;
  clientTimestamp: string;
  serverTimestamp: string;
  firstSeenAt: string;
}

/** 署名アルゴリズム識別子 */
export type SignedCheckpointAlgorithm = 'ECDSA-P256';

/** 署名 envelope (payload + 署名 + 鍵参照) */
export interface SignedCheckpointEnvelope {
  payload: SignedCheckpointPayload;
  signature: string;
  keyId: string;
  algorithm: SignedCheckpointAlgorithm;
  /** 長期検証用に同梱可能な公開鍵 (JWK) */
  publicKeyJwk?: JsonWebKey;
  /** 同梱公開鍵の有効開始時刻 (ISO) */
  publicKeyValidFrom?: string;
  /** 同梱公開鍵の有効終了時刻 (ISO) */
  publicKeyValidUntil?: string;
}

/** 個別 signed checkpoint の検証結果 */
export interface SignedCheckpointVerificationDetail {
  checkpointIndex: number;
  eventIndex: number;
  valid: boolean;
  warning?: 'key-revoked-but-trusted-by-time';
  reason?: string;
}

/** signed checkpoint 全体の検証結果 */
export interface SignedCheckpointsVerificationResult {
  valid: boolean;
  /** signed checkpoint が一つもなければ true (ただし anchored=false) */
  anchored: boolean;
  /** 個別検証結果 */
  details: SignedCheckpointVerificationDetail[];
  /** カバレッジ情報 */
  coverage: {
    signedCount: number;
    lastSignedEventIndex: number | null;
    /** 0..1。signed checkpoint が指す eventIndex 最大値 / 全 event 数 */
    coverageRatio: number;
  };
  /** post-hoc batch signing 疑い指標 */
  temporal: {
    serverSpanMs: number;
    clientSpanMs: number;
    /** serverSpan / clientSpan。clientSpan == 0 の時は null */
    ratio: number | null;
    /** ratio < 0.1 もしくは serverSpan < 60s & clientSpan > 600s で true */
    postHocSuspected: boolean;
  } | null;
  /** 失敗理由 (valid=false 時) */
  reason?: string;
  errorAt?: number;
}
