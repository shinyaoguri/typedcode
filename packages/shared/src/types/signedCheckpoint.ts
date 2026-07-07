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
  /**
   * anchoring 密度メトリクス (ADR-0016)。署名 cp が「主張したイベント数 / 経過時間」に対して
   * 十分な間隔で打たれているかを計量する。末尾 1 個の署名 cp で長いチェーンを「アンカー済み」に
   * 見せる手口 (coverageRatio 最大 1.0・postHocSuspected=false) を補足するためのシグナル。
   * signed checkpoint が一つも無い (anchored=false) ときは null。
   */
  density: {
    /** 最初の署名 cp が指す eventIndex */
    firstAnchorEventIndex: number;
    /** 最初の署名 cp までの未アンカー event 数 (= firstAnchorEventIndex) */
    firstAnchorLatencyEvents: number;
    /**
     * firstSeenAt から最初の署名 serverTimestamp までの ms。
     * 現アーキでは最初の署名 cp の serverTimestamp が firstSeenAt と一致するため構造的に ~0。
     * session/start アンカー (ADR-0017) 導入後に「開始から初アンカーまでの遅延」として意味を持つ。
     * firstSeenAt が不明なときは null。
     */
    firstAnchorLatencyServerMs: number | null;
    /** 連続署名 cp 間 (先頭=event0 境界 / 末尾=最終 event 境界 を含む) の eventIndex 最大ギャップ */
    maxGapEvents: number;
    /** 連続署名 cp 間 serverTimestamp の最大ギャップ ms (先頭は firstSeenAt 起点。末尾境界は時刻不明のため除外) */
    maxGapServerMs: number;
    /** 保守的閾値を超え anchoring が疎と判定されたか (warning シグナル / strict 時は valid=false の根拠) */
    sparse: boolean;
  } | null;
  /** 失敗理由 (valid=false 時) */
  reason?: string;
  errorAt?: number;
}
