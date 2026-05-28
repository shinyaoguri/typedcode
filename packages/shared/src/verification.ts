/**
 * Verification utilities for TypedCode proof files
 * Platform-agnostic verification functions that can be used in both browser and Node.js
 */

import type {
  StoredEvent,
  VerificationResult,
  ContentReplayVerificationResult,
  ProofData,
  PoSWData,
  EventHashData,
  ExportedProof,
} from './types.js';

// Re-export hash utilities for backward compatibility
export {
  deterministicStringify,
  arrayBufferToHex,
  computeHash,
} from './utils/hashUtils.js';

import { deterministicStringify, computeHash } from './utils/hashUtils.js';

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
  rootValid?: boolean;
  chainValid: boolean;
  finalHashValid?: boolean;
  contentValid?: boolean;
  isPureTyping: boolean;
  errorAt?: number;
  errorMessage?: string;
}

/**
 * PoSW (Proof of Sequential Work) statistics
 */
export interface PoswStats {
  /** Number of PoSW events */
  count: number;
  /** Average compute time in milliseconds */
  avgTimeMs: number;
  /** Total compute time in milliseconds */
  totalTimeMs: number;
  /** Iterations per PoSW */
  iterations: number;
}

/**
 * Progress callback for verification
 */
export type VerificationProgressCallback = (current: number, total: number) => void;

/**
 * Verify that the hash chain starts from the exported fingerprint and nonce.
 */
export async function verifyInitialHashRoot(
  proof: Pick<ExportedProof, 'typingProofData' | 'proof' | 'fingerprint'>
): Promise<{ valid: boolean; reason?: string; computedInitialHash?: string; expectedInitialHash?: string }> {
  const fingerprintHash = proof.fingerprint?.hash;
  const fingerprintComponents = proof.fingerprint?.components;
  const proofData = proof.typingProofData;

  if (!fingerprintHash || !fingerprintComponents) {
    return { valid: false, reason: 'Fingerprint data is missing' };
  }

  if (proofData.deviceId !== fingerprintHash) {
    return { valid: false, reason: 'Proof deviceId does not match fingerprint hash' };
  }

  const fingerprintHashCandidates = new Set<string>([
    await computeHash(JSON.stringify(fingerprintComponents, null, 0)),
    await computeHash(deterministicStringify(fingerprintComponents)),
  ]);

  if (!fingerprintHashCandidates.has(fingerprintHash)) {
    return { valid: false, reason: 'Fingerprint components do not match fingerprint hash' };
  }

  const nonce = proofData.initialHashNonce;
  if (!nonce || !/^[0-9a-f]{64}$/i.test(nonce)) {
    return { valid: false, reason: 'Initial hash nonce is missing or invalid' };
  }

  const expectedInitialHash = proofData.initialEventChainHash;
  if (!expectedInitialHash) {
    return { valid: false, reason: 'Initial event chain hash is missing' };
  }

  const computedInitialHash = await computeHash(fingerprintHash + nonce);
  if (computedInitialHash !== expectedInitialHash) {
    return {
      valid: false,
      reason: 'Initial event chain hash does not match fingerprint and nonce',
      computedInitialHash,
      expectedInitialHash,
    };
  }

  const rootUsedByEvents = proof.proof.events[0]?.previousHash ?? proof.proof.finalHash;
  if (rootUsedByEvents !== expectedInitialHash) {
    return {
      valid: false,
      reason: 'First event does not start from the declared initial chain hash',
      computedInitialHash: rootUsedByEvents ?? undefined,
      expectedInitialHash,
    };
  }

  return { valid: true, computedInitialHash, expectedInitialHash };
}

function isTemplateInjectionData(data: unknown): data is { content: string } {
  return typeof data === 'object' && data !== null && typeof (data as { content?: unknown }).content === 'string';
}

function offsetFromRange(content: string, event: StoredEvent): number | null {
  if (typeof event.rangeOffset === 'number') {
    return event.rangeOffset;
  }

  const range = event.range;
  if (!range) return null;

  const lines = content.split('\n');
  const lineIndex = range.startLineNumber - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;

  const columnIndex = range.startColumn - 1;
  const line = lines[lineIndex] ?? '';
  if (columnIndex < 0 || columnIndex > line.length) return null;

  let offset = columnIndex;
  for (let i = 0; i < lineIndex; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset;
}

function firstMismatchIndex(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return i;
  }
  return length;
}

/**
 * Replay content-affecting events and compare them with the exported final content.
 */
export function verifyContentReplay(
  events: StoredEvent[],
  finalContent: string
): ContentReplayVerificationResult {
  let content = '';

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    if (event.type === 'templateInjection') {
      if (!isTemplateInjectionData(event.data)) {
        return { valid: false, reason: `Invalid template injection data at event ${i}`, errorAt: i };
      }
      content = event.data.content;
      continue;
    }

    if (event.type === 'contentSnapshot') {
      if (typeof event.data !== 'string') {
        return { valid: false, reason: `Invalid content snapshot data at event ${i}`, errorAt: i };
      }
      content = event.data;
      continue;
    }

    if (event.type !== 'contentChange') {
      continue;
    }

    if (event.inputType === 'insertFromInternalPaste' && event.rangeOffset == null) {
      continue;
    }

    if (typeof event.data !== 'string') {
      return { valid: false, reason: `Invalid content change data at event ${i}`, errorAt: i };
    }

    const offset = offsetFromRange(content, event);
    const rangeLength = event.rangeLength ?? 0;
    if (offset === null || rangeLength < 0 || offset < 0 || offset + rangeLength > content.length) {
      return { valid: false, reason: `Content change range is out of bounds at event ${i}`, errorAt: i };
    }

    content = content.slice(0, offset) + event.data + content.slice(offset + rangeLength);
  }

  if (content !== finalContent) {
    return {
      valid: false,
      reason: 'Replayed content does not match exported final content',
      reconstructedContent: content,
      mismatchIndex: firstMismatchIndex(content, finalContent),
    };
  }

  return { valid: true, reconstructedContent: content };
}

/**
 * Compare the verified terminal chain hash with all exported final hash fields.
 */
export function verifyFinalChainHash(
  proof: Pick<ExportedProof, 'typingProofData' | 'proof'>,
  computedFinalHash?: string
): { valid: boolean; reason?: string; computedFinalHash?: string; expectedFinalHash?: string | null } {
  const events = proof.proof.events;
  const finalHash = computedFinalHash ?? (events.length === 0 ? proof.typingProofData.initialEventChainHash ?? undefined : undefined);

  if (!finalHash) {
    return { valid: false, reason: 'Computed final chain hash is missing' };
  }

  if (proof.proof.finalHash !== finalHash) {
    return {
      valid: false,
      reason: 'Signature final hash does not match verified chain hash',
      computedFinalHash: finalHash,
      expectedFinalHash: proof.proof.finalHash,
    };
  }

  if (proof.typingProofData.finalEventChainHash !== finalHash) {
    return {
      valid: false,
      reason: 'Typing proof final chain hash does not match verified chain hash',
      computedFinalHash: finalHash,
      expectedFinalHash: proof.typingProofData.finalEventChainHash,
    };
  }

  return { valid: true, computedFinalHash: finalHash, expectedFinalHash: finalHash };
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
    computedHash: hash ?? undefined,
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
  let rootValid = false;
  let isPureTyping = false;
  let metadataError: string | undefined;

  if (proof.typingProofHash && proof.typingProofData && proof.content !== undefined && proof.content !== null) {
    const metaResult = await verifyTypingProofHash(
      proof.typingProofHash,
      proof.typingProofData,
      proof.content
    );
    const rootResult = await verifyInitialHashRoot(proof);
    rootValid = rootResult.valid;
    metadataValid = metaResult.valid && rootValid;
    metadataError = metaResult.valid ? rootResult.reason : 'Typing proof hash does not match metadata';
    isPureTyping = metaResult.isPureTyping;
  } else {
    metadataError = 'Typing proof metadata is missing';
  }

  // 2. Verify hash chain
  const chainResult = await verifyChain(events, onProgress);
  const finalHashResult = chainResult.valid
    ? verifyFinalChainHash(proof, chainResult.computedHash)
    : { valid: false, reason: chainResult.message };
  const contentResult = proof.content !== undefined && proof.content !== null
    ? verifyContentReplay(events, proof.content)
    : { valid: false, reason: 'Final content is missing' };
  const chainValid = chainResult.valid && finalHashResult.valid && contentResult.valid;
  const verificationError = !metadataValid
    ? metadataError
    : !chainResult.valid
      ? chainResult.message
      : !finalHashResult.valid
        ? finalHashResult.reason
        : !contentResult.valid
          ? contentResult.reason
          : chainResult.message;

  return {
    valid: metadataValid && chainValid,
    metadataValid,
    rootValid,
    chainValid,
    finalHashValid: finalHashResult.valid,
    contentValid: contentResult.valid,
    isPureTyping,
    errorAt: chainResult.errorAt,
    errorMessage: verificationError,
  };
}

/**
 * Calculate PoSW statistics from events
 * @param events - Array of stored events
 * @returns PoSW statistics or undefined if no PoSW data
 */
export function calculatePoswStats(events: StoredEvent[]): PoswStats | undefined {
  if (!events || events.length === 0) return undefined;

  let count = 0;
  let totalTimeMs = 0;
  let iterations = 0;

  for (const event of events) {
    if (event.posw) {
      count++;
      totalTimeMs += event.posw.computeTimeMs || 0;
      // Use the first event's iterations (should be consistent)
      if (iterations === 0) {
        iterations = event.posw.iterations || 0;
      }
    }
  }

  if (count === 0) return undefined;

  return {
    count,
    avgTimeMs: totalTimeMs / count,
    totalTimeMs,
    iterations,
  };
}
