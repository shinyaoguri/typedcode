/**
 * Verification utilities for TypedCode proof files
 * Platform-agnostic verification functions that can be used in both browser and Node.js
 */

import type {
  StoredEvent,
  VerificationResult,
  ProofData,
  PoSWData,
  EventHashData,
  ExportedProof,
} from './types.js';

/**
 * Proof file with content (extends ExportedProof)
 */
export interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

/**
 * Result of full verification
 */
export interface FullVerificationResult {
  valid: boolean;
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  errorAt?: number;
  errorMessage?: string;
}

/**
 * Progress callback for verification
 */
export type VerificationProgressCallback = (current: number, total: number) => void;

/**
 * Deterministic JSON stringify (sorted keys)
 * Ensures consistent hash calculation across platforms
 */
export function deterministicStringify(obj: unknown): string {
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
export function arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(uint8Array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute SHA-256 hash
 */
export async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return arrayBufferToHex(hashBuffer);
}

/**
 * Verify PoSW (Proof of Sequential Work)
 */
export async function verifyPoSW(
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
export async function verifyTypingProofHash(
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
export async function verifyChain(
  events: StoredEvent[],
  onProgress?: VerificationProgressCallback
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

    if (onProgress) {
      onProgress(i + 1, total);
    }
  }

  return {
    valid: true,
    message: 'All hashes verified successfully',
  };
}

/**
 * Verify a complete proof file
 */
export async function verifyProofFile(
  proof: ProofFile,
  onProgress?: VerificationProgressCallback
): Promise<FullVerificationResult> {
  const events = proof.proof.events;

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
  const chainResult = await verifyChain(events, onProgress);

  return {
    valid: metadataValid && chainResult.valid,
    metadataValid,
    chainValid: chainResult.valid,
    isPureTyping,
    errorAt: chainResult.errorAt,
    errorMessage: chainResult.message,
  };
}
