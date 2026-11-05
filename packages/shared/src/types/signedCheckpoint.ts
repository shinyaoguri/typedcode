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
    /**
     * 最後の署名 cp より後のイベント数 (= 未署名の末尾。#295)。サーバ署名のどれにも覆われず、
     * 時刻の上界を持たない。署名 cp が無ければ events.length。0 未満にはならない
     * (eventIndex が範囲外の不正な cp でも 0 に丸める)。
     */
    unsignedTailEvents: number;
    /**
     * 署名 cp があり、最後の署名 cp の eventIndex が最終イベント (events.length - 1) を指すか (#295)。
     * 三層保証の temporal が `anchored` を名乗る条件の一つ (ADR-0020)。
     */
    terminalAnchored: boolean;
  };
  /**
   * post-hoc (事後一括署名) 疑い指標 (#320)。ハッシュ対象のイベント時刻 (`event.timestamp`) とサーバ時刻
   * (`serverTimestamp`) を照合する。申告値の `clientTimestamp` は判定に使わない。検査を通った署名 cp が無ければ null。
   */
  temporal: {
    /** 最初から最後の署名 cp までの serverTimestamp の幅 (ms) */
    serverSpanMs: number;
    /** 最初から最後の署名 cp までの clientTimestamp (申告値) の幅 (ms)。表示用の参考値で、判定に使わない */
    clientSpanMs: number;
    /** serverSpan / clientSpan。clientSpan == 0 の時は null。表示用の参考値で、判定に使わない */
    ratio: number | null;
    /** 最初から最後の署名 cp が指すイベントの時刻 (`event.timestamp`) の幅 (ms) */
    eventSpanMs: number;
    /**
     * 照合した全ペア (k < j) の (e_j − e_k) − (s_j − s_k) の最大 (ms)。イベント時刻がサーバ時刻より
     * どれだけ先に進んだか。root が検証済みなら token の issuedAt (と events[0]) を基点に含む。負なら 0
     */
    maxEventLeadMs: number;
    /**
     * 任意の 2 点 k < j で (e_j − e_k) − (s_j − s_k) > max(60s, 1% × (s_j − s_k)) なら true。
     * 照合する点のイベント時刻が有限の数でないときも true (fail-closed)
     */
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
    /**
     * 連続署名 cp 間 serverTimestamp の最大ギャップ ms (先頭は firstSeenAt 起点。末尾境界は時刻不明のため除外)。
     * 表示用の生の値で、`sparse` の判定には使わない (正直な無操作でも大きくなる。#320)
     */
    maxGapServerMs: number;
    /**
     * 連続署名 cp 間のサーバ時刻の空白のうち、イベント時刻で説明できない分 ((s_j − s_{j−1}) − (e_j − e_{j−1})) の
     * 最大 ms (#320)。先頭 (firstSeenAt → 初アンカー) は生の差で含める。無操作の区間 (Δe ≈ Δs) は 0 に近い
     */
    maxUnexplainedGapServerMs: number;
    /**
     * 連続署名 cp k, k+1 の間にある (cp を持たない) イベント x の e_x − e_k の最大 ms (#320)。
     * 署名で挟まれていないイベントが、直前の署名 cp からイベント時刻でどれだけ進んだか。
     * 最初の署名 cp より前・最後の署名 cp より後のイベントは数えない
     */
    maxUnanchoredEventSpanMs: number;
    /**
     * 保守的閾値を超え anchoring が疎と判定されたか (warning シグナル。`valid` は落とさない。不受理にするのは受理ポリシーの
     * `anchor-density-sparse`。#296)。maxGapEvents > 500・maxUnexplainedGapServerMs > 50s・
     * maxUnanchoredEventSpanMs > 50s・firstAnchorLatencyEvents > 500 のどれか、または照合するイベント時刻が
     * 有限の数でないとき true
     */
    sparse: boolean;
  } | null;
  /** 失敗理由 (valid=false 時) */
  reason?: string;
  errorAt?: number;
}
