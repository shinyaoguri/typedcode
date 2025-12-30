/**
 * Verification logic adapted for CLI
 */

import type {
  ExportedProof,
  ProofData,
  VerificationResult,
  StoredEvent,
  PoSWData,
  EventHashData,
} from '@typedcode/shared';
import { ProgressBar } from './progress.js';

export interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

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
}

/**
 * Deterministic JSON stringify (sorted keys)
 */
function deterministicStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
          (sorted, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          },
          {} as Record<string, unknown>
        );
    }
    return value;
  });
}

/**
 * Convert ArrayBuffer to hex string
 */
function arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(uint8Array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute SHA-256 hash
 */
async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return arrayBufferToHex(hashBuffer);
}

/**
 * Verify PoSW (Proof of Sequential Work)
 */
async function verifyPoSW(
  previousHash: string,
  eventDataString: string,
  posw: PoSWData
): Promise<boolean> {
  let hash = await computeHash(previousHash + eventDataString + posw.nonce);

  for (let i = 1; i < posw.iterations; i++) {
    hash = await computeHash(hash);
  }

  return hash === posw.intermediateHash;
}

/**
 * Verify typing proof hash (metadata)
 */
async function verifyTypingProofHash(
  typingProofHash: string,
  proofData: ProofData,
  finalContent: string
): Promise<{ valid: boolean; isPureTyping: boolean }> {
  const computedContentHash = await computeHash(finalContent);

  if (computedContentHash !== proofData.finalContentHash) {
    return { valid: false, isPureTyping: false };
  }

  const proofString = JSON.stringify(proofData);
  const computedProofHash = await computeHash(proofString);

  if (computedProofHash !== typingProofHash) {
    return { valid: false, isPureTyping: false };
  }

  const isPureTyping =
    proofData.metadata.pasteEvents === 0 && proofData.metadata.dropEvents === 0;

  return { valid: true, isPureTyping };
}

/**
 * Verify hash chain with PoSW
 */
async function verifyChain(
  events: StoredEvent[],
  onProgress: (current: number, total: number) => void
): Promise<VerificationResult> {
  let hash = events[0]?.previousHash ?? null;
  let lastTimestamp = -Infinity;
  const total = events.length;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    // Sequence check
    if (event.sequence !== i) {
      return {
        valid: false,
        errorAt: i,
        message: `Sequence mismatch at event ${i}: expected ${i}, got ${event.sequence}`,
        event,
      };
    }

    // Timestamp check
    if (event.timestamp < lastTimestamp) {
      return {
        valid: false,
        errorAt: i,
        message: `Timestamp violation at event ${i}`,
        event,
      };
    }
    lastTimestamp = event.timestamp;

    // Previous hash check
    if (event.previousHash !== hash) {
      return {
        valid: false,
        errorAt: i,
        message: `Previous hash mismatch at event ${i}`,
        event,
      };
    }

    // Build event data for PoSW verification
    const eventDataWithoutPoSW = {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      inputType: event.inputType,
      data: event.data,
      rangeOffset: event.rangeOffset,
      rangeLength: event.rangeLength,
      range: event.range,
      previousHash: event.previousHash,
    };

    // PoSW verification
    const eventDataStringForPoSW = deterministicStringify(eventDataWithoutPoSW);
    const poswValid = await verifyPoSW(hash ?? '', eventDataStringForPoSW, event.posw);

    if (!poswValid) {
      return {
        valid: false,
        errorAt: i,
        message: `PoSW verification failed at event ${i}`,
        event,
      };
    }

    // Hash verification
    const eventData: EventHashData = {
      ...eventDataWithoutPoSW,
      posw: event.posw,
    };

    const eventString = deterministicStringify(eventData);
    const combinedData = hash + eventString;
    const computedHash = await computeHash(combinedData);

    if (computedHash !== event.hash) {
      return {
        valid: false,
        errorAt: i,
        message: `Hash mismatch at event ${i}`,
        event,
        expectedHash: event.hash,
        computedHash,
      };
    }

    hash = event.hash;
    onProgress(i + 1, total);
  }

  return {
    valid: true,
    message: 'All hashes verified successfully',
  };
}

export async function verifyProof(proof: ProofFile): Promise<CLIVerificationResult> {
  const startTime = performance.now();
  const events = proof.proof.events;
  const eventCount = events.length;

  // 1. Verify metadata
  let metadataValid = false;
  let isPureTyping = false;

  if (proof.typingProofHash && proof.typingProofData && proof.content) {
    const metaResult = await verifyTypingProofHash(
      proof.typingProofHash,
      proof.typingProofData,
      proof.content
    );
    metadataValid = metaResult.valid;
    isPureTyping = metaResult.isPureTyping;
  }

  // 2. Verify hash chain
  console.log('');
  const progressBar = new ProgressBar(eventCount, 'Verifying');

  const chainResult = await verifyChain(events, (current) => {
    progressBar.update(current);
  });

  progressBar.complete();

  // 3. Calculate statistics
  const pasteEvents = events.filter((e) => e.inputType === 'insertFromPaste').length;
  const dropEvents = events.filter((e) => e.inputType === 'insertFromDrop').length;

  const firstPoswEvent = events.find((e) => e.posw);
  const poswIterations = firstPoswEvent?.posw?.iterations;

  const duration = (performance.now() - startTime) / 1000;

  return {
    valid: metadataValid && chainResult.valid,
    metadataValid,
    chainValid: chainResult.valid,
    isPureTyping,
    eventCount,
    duration,
    pasteEvents,
    dropEvents,
    poswIterations,
    errorAt: chainResult.errorAt,
    errorMessage: chainResult.message,
    language: proof.language,
  };
}
