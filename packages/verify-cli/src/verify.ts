/**
 * Verification logic for CLI
 * Uses shared verification utilities from @typedcode/shared
 */

import {
  verifyProofFile,
  type ProofFile,
  type VerificationProgressCallback,
  type VerificationMode,
  type FullVerificationResult,
} from '@typedcode/shared';
import { ProgressBar } from './progress.js';

// Re-export ProofFile for use in other modules
export type { ProofFile };

export interface CLIVerificationResult {
  valid: boolean;
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  eventCount: number;
  duration: number;
  pasteEvents: number;
  dropEvents: number;
  poswIterations?: number;
  errorAt?: number;
  errorMessage?: string;
  language: string;
  mode: VerificationMode;
  poswSkipped: boolean;
  signedCheckpoints: FullVerificationResult['signedCheckpoints'];
}

export async function verifyProof(
  proof: ProofFile,
  options: { mode?: VerificationMode } = {}
): Promise<CLIVerificationResult> {
  const mode: VerificationMode = options.mode ?? 'full';
  const startTime = performance.now();
  const events = proof.proof.events;
  const eventCount = events.length;

  // Setup progress bar
  console.log('');
  const progressBar = new ProgressBar(eventCount, 'Verifying');

  const onProgress: VerificationProgressCallback = (current) => {
    progressBar.update(current);
  };

  // Run verification using shared utilities
  const result = await verifyProofFile(proof, onProgress, { mode });

  progressBar.complete();

  // Calculate statistics
  const pasteEvents = events.filter((e) => e.inputType === 'insertFromPaste').length;
  const dropEvents = events.filter((e) => e.inputType === 'insertFromDrop').length;

  const firstPoswEvent = events.find((e) => e.posw);
  const poswIterations = firstPoswEvent?.posw?.iterations;

  const duration = (performance.now() - startTime) / 1000;

  return {
    valid: result.valid,
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    isPureTyping: result.isPureTyping,
    eventCount,
    duration,
    pasteEvents,
    dropEvents,
    poswIterations,
    errorAt: result.errorAt,
    errorMessage: result.errorMessage,
    language: proof.language,
    mode,
    poswSkipped: result.poswSkipped ?? false,
    signedCheckpoints: result.signedCheckpoints,
  };
}
