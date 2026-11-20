/**
 * 検証関連の型定義
 */

import type { StoredEvent, EventHashData, ProofMetadata } from './proof.js';

/**
 * `verifyChain` がどの検査で止まったか (#809)。`message` の文字列を parse せずに、チェーンの連結と
 * PoSW の再計算のどちらで落ちたかを分けるための機械可読の値。
 * - `posw-iterations-mismatch` は fast でも full でも見る反復数の照合 (チェーンの検査に数える)
 * - `posw-mismatch` は full だけが行う `intermediateHash` の再計算の不一致
 */
export type ChainFailureCode =
  | 'sequence-mismatch'
  | 'timestamp-regression'
  | 'previous-hash-mismatch'
  | 'posw-iterations-mismatch'
  | 'posw-mismatch'
  | 'hash-mismatch';

/** ハッシュ検証結果 */
export interface VerificationResult {
  valid: boolean;
  message: string;
  /** `valid: false` のときだけ付く、止まった検査の種類 (#809) */
  failure?: ChainFailureCode;
  errorAt?: number;
  event?: StoredEvent;
  eventData?: EventHashData;
  expectedHash?: string;
  computedHash?: string;
  previousTimestamp?: number;
  currentTimestamp?: number;
}

/** 最終コンテンツ再構築検証結果 */
export interface ContentReplayVerificationResult {
  valid: boolean;
  reason?: string;
  reconstructedContent?: string;
  mismatchIndex?: number;
  errorAt?: number;
}

/** proof metadata とイベント列の照合結果 */
export interface ProofMetadataVerificationResult {
  valid: boolean;
  reason?: string;
  isPureTyping: boolean;
  recomputedMetadata: ProofMetadata;
  suspiciousBulkInsertEventIndexes: number[];
  /**
   * replay 文書と乖離した contentSnapshot の event index (#175)。挿入イベント無しで
   * 文書を丸ごと差し替える持ち込み口。1 つでもあれば isPureTyping=false (advisory のみ、
   * valid には影響しない)。editor の正規 snapshot は replay と常に一致するため載らない。
   */
  divergentContentSnapshotEventIndexes: number[];
}
