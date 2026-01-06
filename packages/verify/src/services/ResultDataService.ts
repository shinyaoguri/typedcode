/**
 * ResultDataService - Pure calculation functions for verification results
 *
 * Core calculation functions are now provided by @typedcode/shared.
 * This module re-exports them for backward compatibility and adds
 * UI-specific functions for the verify package.
 */

import type { PoswStats, HumanAttestationUI, VerifyTabState } from '../types';
import type { ResultData, VerificationResult } from '../ui/ResultPanel';

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
  const pasteCount = proofData.metadata?.pasteEvents ?? countPasteEventsShared(events);

  const result: VerificationResult = {
    chainValid: verificationResult.chainValid,
    pureTyping: verificationResult.isPureTyping,
    pasteCount,
    verificationMethod: verificationResult.sampledResult ? 'sampled' : 'full',
  };

  // Convert PoSW stats
  const poswStats: PoswStats | undefined = verificationResult.poswStats
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
