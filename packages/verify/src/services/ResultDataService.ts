/**
 * ResultDataService - Pure calculation functions for verification results
 *
 * Core calculation functions are now provided by @typedcode/shared.
 * This module re-exports them for backward compatibility and adds
 * UI-specific functions for the verify package.
 */

import type { PoswStatsDisplay, HumanAttestationUI, VerifyTabState, ChainErrorDetails, SampledVerificationInfo, VerificationResult } from '../types';
import type { ResultData } from '../ui/ResultPanel';

// Re-export from shared for backward compatibility
export {
  formatTypingTime,
  calculateTypingSpeed,
  countPasteEvents,
  countDropEvents,
  calculateChartStats,
  type ChartStats,
} from '@typedcode/shared';

import {
  formatTypingTime,
  calculateTypingSpeed as calculateTypingSpeedShared,
  countPasteEvents as countPasteEventsShared,
  TypingPatternAnalyzer,
} from '@typedcode/shared';

/**
 * エラーメッセージからエラータイプを判定
 */
function parseErrorType(message?: string): ChainErrorDetails['errorType'] {
  if (!message) return 'unknown';
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('sequence')) return 'sequence';
  if (lowerMessage.includes('timestamp')) return 'timestamp';
  if (lowerMessage.includes('previous hash')) return 'previousHash';
  if (lowerMessage.includes('posw')) return 'posw';
  if (lowerMessage.includes('segment end hash')) return 'segmentEnd';
  if (lowerMessage.includes('hash')) return 'hash';
  return 'unknown';
}

/**
 * Build ResultData from tab state
 */
export function buildResultData(tabState: VerifyTabState): ResultData | null {
  if (!tabState.proofData || !tabState.verificationResult) return null;

  const { proofData, verificationResult } = tabState;
  const events = proofData.proof?.events;

  // Calculate stats
  const eventCount = events?.length || 0;
  const typingTime = formatTypingTime(events);
  const contentLength = proofData.content?.length || 0;
  const typingSpeed = calculateTypingSpeedShared(contentLength, events);

  // Convert result format
  // pasteCountはメタデータから取得（イベントからカウントするよりも正確）
  // メタデータがない場合はイベントからカウント
  // ExportedProof.typingProofData.metadata が ProofMetadata（正確な統計情報）
  // ExportedProof.metadata は { userAgent, timestamp, isPureTyping } のみ
  const proofMetadata = proofData.typingProofData?.metadata;
  const pasteCount = proofMetadata?.pasteEvents ?? countPasteEventsShared(events);
  // 内部ペーストカウント（後方互換性のため、存在しない場合は0）
  const internalPasteCount = proofMetadata?.internalPasteEvents ?? 0;

  // Build chain error details if verification failed
  let chainErrorDetails: ChainErrorDetails | undefined;
  if (!verificationResult.chainValid && verificationResult.errorAt !== undefined) {
    chainErrorDetails = {
      errorAt: verificationResult.errorAt,
      errorType: parseErrorType(verificationResult.message),
      message: verificationResult.message || 'Unknown error',
      expectedHash: verificationResult.expectedHash,
      computedHash: verificationResult.computedHash,
      previousTimestamp: verificationResult.previousTimestamp,
      currentTimestamp: verificationResult.currentTimestamp,
      totalEvents: verificationResult.totalEvents ?? eventCount,
    };
  }

  // Build sampled verification info if available
  let sampledVerification: SampledVerificationInfo | undefined;
  if (verificationResult.sampledResult) {
    sampledVerification = {
      segments: verificationResult.sampledResult.sampledSegments.map((seg) => ({
        startIndex: seg.startIndex,
        endIndex: seg.endIndex,
        eventCount: seg.eventCount,
        verified: seg.verified,
      })),
      totalSegments: verificationResult.sampledResult.totalSegments,
      totalEventsVerified: verificationResult.sampledResult.totalEventsVerified,
      totalEvents: verificationResult.sampledResult.totalEvents,
    };
  }

  const result: VerificationResult = {
    chainValid: verificationResult.chainValid,
    pureTyping: verificationResult.isPureTyping,
    pasteCount,
    internalPasteCount,
    verificationMethod: verificationResult.sampledResult ? 'sampled' : 'full',
    chainErrorDetails,
    sampledVerification,
  };

  // Convert PoSW stats (from shared PoswStats to UI PoswStatsDisplay)
  const poswStats: PoswStatsDisplay | undefined = verificationResult.poswStats
    ? {
        totalIterations: verificationResult.poswStats.iterations,
        totalTime: verificationResult.poswStats.totalTimeMs,
        avgTime: verificationResult.poswStats.avgTimeMs,
      }
    : undefined;

  // Convert attestations
  const attestations: HumanAttestationUI[] = [];
  if (tabState.humanAttestationResult?.hasAttestation) {
    if (tabState.humanAttestationResult.createValid !== undefined) {
      attestations.push({
        type: 'create',
        eventIndex: 0,
        valid: tabState.humanAttestationResult.createValid,
      });
    }
    if (tabState.humanAttestationResult.exportValid !== undefined) {
      attestations.push({
        type: 'export',
        valid: tabState.humanAttestationResult.exportValid,
      });
    }
  }

  // Analyze typing patterns
  const typingPatternAnalyzer = new TypingPatternAnalyzer();
  const typingPatternAnalysis = events && events.length > 0
    ? typingPatternAnalyzer.analyze(events)
    : undefined;

  return {
    filename: tabState.filename,
    content: proofData.content || '',
    language: tabState.language,
    result,
    poswStats,
    attestations: attestations.length > 0 ? attestations : undefined,
    eventCount,
    typingTime,
    typingSpeed,
    typingPatternAnalysis,
  };
}
