/**
 * ResultDataService - Pure calculation functions for verification results
 */

import type { ProofFile, StoredEvent, PoswStats, HumanAttestationUI, VerifyTabState } from '../types';
import type { ResultData, VerificationResult } from '../ui/ResultPanel';

export interface ChartStats {
  keydownCount: number;
  avgDwellTime: number;
  avgFlightTime: number;
  mouseEventCount: number;
}

/**
 * Format typing time from events
 */
export function formatTypingTime(events?: StoredEvent[]): string {
  if (!events || events.length < 2) return '-';

  const firstTime = events[0]!.timestamp;
  const lastTime = events[events.length - 1]!.timestamp;
  const totalMs = lastTime - firstTime;

  const seconds = Math.floor(totalMs / 1000) % 60;
  const minutes = Math.floor(totalMs / 60000);

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Calculate typing speed in CPM (characters per minute)
 */
export function calculateTypingSpeed(proofData: ProofFile, events?: StoredEvent[]): string {
  if (!events || events.length < 2) return '-';

  const contentLength = proofData.content?.length || 0;
  const firstTime = events[0]!.timestamp;
  const lastTime = events[events.length - 1]!.timestamp;
  const minutes = (lastTime - firstTime) / 60000;

  if (minutes <= 0) return '-';

  const cpm = Math.round(contentLength / minutes);
  return `${cpm} CPM`;
}

/**
 * Count paste events in proof data
 */
export function countPasteEvents(proofData: ProofFile): number {
  const events = proofData.proof?.events;
  if (!events) return 0;

  return events.filter(
    (e) => e.type === 'contentChange' && e.inputType === 'insertFromPaste'
  ).length;
}

/**
 * Calculate chart statistics from events
 */
export function calculateChartStats(events: StoredEvent[]): ChartStats {
  let keydownCount = 0;
  let mouseEventCount = 0;
  const dwellTimes: number[] = [];
  const flightTimes: number[] = [];
  let lastKeyUpTime = 0;

  for (const event of events) {
    if (event.type === 'keyDown') {
      keydownCount++;
      if (lastKeyUpTime > 0) {
        flightTimes.push(event.timestamp - lastKeyUpTime);
      }
    } else if (event.type === 'keyUp') {
      lastKeyUpTime = event.timestamp;
    } else if (event.type === 'mousePositionChange') {
      mouseEventCount++;
    }
  }

  return {
    keydownCount,
    avgDwellTime: dwellTimes.length > 0 ? dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length : 0,
    avgFlightTime: flightTimes.length > 0 ? flightTimes.reduce((a, b) => a + b, 0) / flightTimes.length : 0,
    mouseEventCount,
  };
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
  const typingSpeed = calculateTypingSpeed(proofData, events);

  // Convert result format
  const result: VerificationResult = {
    chainValid: verificationResult.chainValid,
    pureTyping: verificationResult.isPureTyping,
    pasteCount: countPasteEvents(proofData),
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
  };
}
