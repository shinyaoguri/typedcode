/**
 * 検証関連の型定義
 */

import type { StoredEvent, EventHashData, ProofMetadata } from './proof.js';

/** サンプリングされた区間の情報 */
export interface SampledSegmentInfo {
  startIndex: number;
  endIndex: number;
  eventCount: number;
  startHash: string;
  endHash: string;
  verified: boolean;
}

/** サンプリング検証結果 */
export interface SampledVerificationResult {
  sampledSegments: SampledSegmentInfo[];
  totalSegments: number;
  totalEventsVerified: number;
  totalEvents: number;
}

/** ハッシュ検証結果 */
export interface VerificationResult {
  valid: boolean;
  message: string;
  errorAt?: number;
  event?: StoredEvent;
  eventData?: EventHashData;
  expectedHash?: string;
  computedHash?: string;
  previousTimestamp?: number;
  currentTimestamp?: number;
  sampledResult?: SampledVerificationResult;
}

/** タイピング証明ハッシュ検証結果 */
export interface TypingProofVerificationResult {
  valid: boolean;
  reason?: string;
  isPureTyping?: boolean;
  deviceId?: string;
  metadata?: ProofMetadata;
}
