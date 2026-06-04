/**
 * Verification utilities for TypedCode proof files
 * Platform-agnostic verification functions that can be used in both browser and Node.js
 */

import type {
  StoredEvent,
  VerificationResult,
  ContentReplayVerificationResult,
  ProofMetadataVerificationResult,
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
import { POSW_ITERATIONS } from './version.js';
import {
  verifyProofSignedCheckpoints,
} from './signedCheckpoints.js';
import type { SignedCheckpointsVerificationResult } from './types.js';
import type { CheckpointPublicKey } from './checkpointKeys/index.js';

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
  checkpointValid?: boolean;
  isPureTyping: boolean;
  errorAt?: number;
  errorMessage?: string;
  poswSkipped?: boolean;
  signedCheckpoints?: SignedCheckpointsVerificationResult;
}

/**
 * 検証モード。
 * - fast: PoSW 再計算をスキップ。chain integrity / content replay / metadata / signed checkpoint は実施
 * - audit: fast + 決定的 PoSW サンプリング (現実装は full と同等のプレースホルダ)
 * - full: 全 PoSW 再計算を含む完全検証
 */
export type VerificationMode = 'fast' | 'audit' | 'full';

export interface VerifyProofFileOptions {
  mode?: VerificationMode;
  /** 公開鍵レジストリ (テスト/CLI から注入) */
  signedCheckpointKeyRegistry?: readonly CheckpointPublicKey[];
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

function isSuspiciousBulkInsert(event: StoredEvent): boolean {
  if (event.type !== 'contentChange') return false;

  if (event.inputType === 'replaceContent' || event.inputType === 'insertReplacementText') {
    return true;
  }

  return (
    event.inputType === 'insertText' &&
    typeof event.data === 'string' &&
    event.data.length > 1
  );
}

function recomputeProofMetadata(events: StoredEvent[]): ProofMetadataVerificationResult {
  let pasteEvents = 0;
  let internalPasteEvents = 0;
  let dropEvents = 0;
  let insertEvents = 0;
  let deleteEvents = 0;
  const suspiciousBulkInsertEventIndexes: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    if (event.inputType === 'insertFromPaste') pasteEvents++;
    if (event.inputType === 'insertFromInternalPaste') internalPasteEvents++;
    if (event.inputType === 'insertFromDrop') dropEvents++;
    if (event.type === 'contentChange' && event.data) insertEvents++;
    if (event.inputType?.startsWith('delete')) deleteEvents++;
    if (isSuspiciousBulkInsert(event)) {
      suspiciousBulkInsertEventIndexes.push(i);
    }
  }

  const totalTypingTime = events[events.length - 1]?.timestamp ?? 0;
  const averageTypingSpeed = totalTypingTime > 0
    ? Math.round((insertEvents / (totalTypingTime / 60000)) * 10) / 10
    : 0;

  const recomputedMetadata = {
    totalEvents: events.length,
    pasteEvents,
    internalPasteEvents,
    dropEvents,
    insertEvents,
    deleteEvents,
    bulkInsertEvents: suspiciousBulkInsertEventIndexes.length,
    totalTypingTime,
    averageTypingSpeed,
  };

  return {
    valid: true,
    isPureTyping: pasteEvents === 0 && dropEvents === 0 && suspiciousBulkInsertEventIndexes.length === 0,
    recomputedMetadata,
    suspiciousBulkInsertEventIndexes,
  };
}

/**
 * Recompute proof metadata from events and compare self-reported counts.
 */
export function verifyProofMetadata(
  proofData: ProofData,
  events: StoredEvent[]
): ProofMetadataVerificationResult {
  const result = recomputeProofMetadata(events);
  const claimed = proofData.metadata;
  const recomputed = result.recomputedMetadata;
  const countKeys = [
    'totalEvents',
    'pasteEvents',
    'internalPasteEvents',
    'dropEvents',
    'insertEvents',
    'deleteEvents',
  ] as const;

  for (const key of countKeys) {
    if (claimed[key] !== recomputed[key]) {
      return {
        ...result,
        valid: false,
        reason: `Proof metadata mismatch for ${key}: expected ${recomputed[key]}, got ${claimed[key]}`,
      };
    }
  }

  if ((claimed.bulkInsertEvents ?? 0) !== (recomputed.bulkInsertEvents ?? 0)) {
    return {
      ...result,
      valid: false,
      reason: `Proof metadata mismatch for bulkInsertEvents: expected ${recomputed.bulkInsertEvents ?? 0}, got ${claimed.bulkInsertEvents ?? 0}`,
    };
  }

  if (claimed.totalTypingTime < recomputed.totalTypingTime) {
    return {
      ...result,
      valid: false,
      reason: 'Proof metadata totalTypingTime is shorter than the event timeline',
    };
  }

  return result;
}

/**
 * Verify that exported checkpoints match the fully verified event list.
 * Checkpoints are not a substitute for full verification because they are
 * exported with the proof and are not independently signed.
 */
export async function verifyCheckpoints(
  events: StoredEvent[],
  checkpoints?: ExportedProof['checkpoints']
): Promise<{ valid: boolean; reason?: string; errorAt?: number }> {
  if (!checkpoints || checkpoints.length === 0) {
    return { valid: true };
  }

  let lastIndex = -1;
  for (const checkpoint of checkpoints) {
    if (!Number.isInteger(checkpoint.eventIndex) || checkpoint.eventIndex <= lastIndex) {
      return {
        valid: false,
        reason: `Checkpoint index is invalid or unsorted at event ${checkpoint.eventIndex}`,
        errorAt: checkpoint.eventIndex,
      };
    }

    const event = events[checkpoint.eventIndex];
    if (!event) {
      return {
        valid: false,
        reason: `Checkpoint points to missing event ${checkpoint.eventIndex}`,
        errorAt: checkpoint.eventIndex,
      };
    }

    if (checkpoint.hash !== event.hash) {
      return {
        valid: false,
        reason: `Checkpoint hash mismatch at event ${checkpoint.eventIndex}`,
        errorAt: checkpoint.eventIndex,
      };
    }

    if (checkpoint.timestamp !== event.timestamp) {
      return {
        valid: false,
        reason: `Checkpoint timestamp mismatch at event ${checkpoint.eventIndex}`,
        errorAt: checkpoint.eventIndex,
      };
    }

    const expectedContentHash = event.data
      ? await computeHash(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
      : '';

    if (checkpoint.contentHash !== expectedContentHash) {
      return {
        valid: false,
        reason: `Checkpoint content hash mismatch at event ${checkpoint.eventIndex}`,
        errorAt: checkpoint.eventIndex,
      };
    }

    lastIndex = checkpoint.eventIndex;
  }

  return { valid: true };
}

/**
 * Verify PoSW (Proof of Sequential Work)
 */
export async function verifyPoSW(
  previousHash: string,
  eventDataString: string,
  posw: PoSWData
): Promise<boolean> {
  if (posw.iterations !== POSW_ITERATIONS) {
    return false;
  }

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
 *
 * `options.skipPosw: true` で PoSW 反復再計算をスキップする。
 * iterations 値の整合性チェックと hash 連鎖検証は引き続き行う。
 */
export async function verifyChain(
  events: StoredEvent[],
  onProgress?: VerificationProgressCallback,
  options: { skipPosw?: boolean } = {}
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
    if (event.posw.iterations !== POSW_ITERATIONS) {
      return {
        valid: false,
        errorAt: i,
        message: `PoSW iterations mismatch at event ${i}: expected ${POSW_ITERATIONS}, got ${event.posw.iterations}`,
        event,
      };
    }

    if (!options.skipPosw) {
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
    message: options.skipPosw
      ? 'All hashes verified successfully (PoSW skipped)'
      : 'All hashes verified successfully',
    computedHash: hash ?? undefined,
  };
}

/**
 * Verify a complete proof file
 *
 * `options.mode`:
 * - 'fast'  → PoSW 再計算をスキップ。chain/content/metadata/signed checkpoint は実施
 * - 'audit' → 現状は 'full' と同等 (将来: 決定的 PoSW サンプリングを追加)
 * - 'full'  → デフォルト。全 PoSW を再計算
 *
 * 注: 'fast' モードでも、PoSW の **正しさ** だけは保証されないが、proof の
 *     tamper resistance (event 改ざん / reorder / 内容書き換え) は完全に検出される。
 *     signed checkpoint があれば、サーバ署名による temporal anchoring も検証される。
 */
export async function verifyProofFile(
  proof: ProofFile,
  onProgress?: VerificationProgressCallback,
  options: VerifyProofFileOptions = {}
): Promise<FullVerificationResult> {
  const mode = options.mode ?? 'full';
  const skipPosw = mode === 'fast';
  const events = proof.proof.events;

  // 1. Verify metadata
  let metadataValid = false;
  let rootValid = false;
  let isPureTyping = false;
  let metadataError: string | undefined;
  let eventMetadataResult: ProofMetadataVerificationResult | undefined;

  if (proof.typingProofHash && proof.typingProofData && proof.content !== undefined && proof.content !== null) {
    const metaResult = await verifyTypingProofHash(
      proof.typingProofHash,
      proof.typingProofData,
      proof.content
    );
    const rootResult = await verifyInitialHashRoot(proof);
    eventMetadataResult = verifyProofMetadata(proof.typingProofData, events);
    rootValid = rootResult.valid;
    metadataValid = metaResult.valid && rootValid && eventMetadataResult.valid;
    metadataError = !metaResult.valid
      ? 'Typing proof hash does not match metadata'
      : !rootResult.valid
        ? rootResult.reason
        : eventMetadataResult.reason;
    isPureTyping = eventMetadataResult.isPureTyping;
  } else {
    metadataError = 'Typing proof metadata is missing';
  }

  // 2. Verify hash chain (PoSW skipped in fast mode)
  const chainResult = await verifyChain(events, onProgress, { skipPosw });
  const finalHashResult = chainResult.valid
    ? verifyFinalChainHash(proof, chainResult.computedHash)
    : { valid: false, reason: chainResult.message };
  const checkpointResult = await verifyCheckpoints(events, proof.checkpoints);
  const contentResult = proof.content !== undefined && proof.content !== null
    ? verifyContentReplay(events, proof.content)
    : { valid: false, reason: 'Final content is missing' };
  const chainValid = chainResult.valid && finalHashResult.valid && checkpointResult.valid && contentResult.valid;

  // 3. Verify signed checkpoints (mode independent; only affects "anchored" axis)
  const signedCheckpointResult = await verifyProofSignedCheckpoints(proof, {
    registry: options.signedCheckpointKeyRegistry,
  });

  const verificationError = !metadataValid
    ? metadataError
    : !chainResult.valid
      ? chainResult.message
      : !finalHashResult.valid
        ? finalHashResult.reason
        : !checkpointResult.valid
          ? checkpointResult.reason
          : !contentResult.valid
            ? contentResult.reason
            : signedCheckpointResult.anchored && !signedCheckpointResult.valid
              ? signedCheckpointResult.reason
              : chainResult.message;

  // signed checkpoint が存在しつつ無効なら全体も無効。存在しない (anchored=false) のは
  // 「補助情報が無い」だけで、tamper resistance は他レイヤで担保される。
  const signedCheckpointBlocks = signedCheckpointResult.anchored && !signedCheckpointResult.valid;

  return {
    valid: metadataValid && chainValid && !signedCheckpointBlocks,
    metadataValid,
    rootValid,
    chainValid,
    finalHashValid: finalHashResult.valid,
    contentValid: contentResult.valid,
    checkpointValid: checkpointResult.valid,
    isPureTyping,
    errorAt: chainResult.errorAt ?? checkpointResult.errorAt ?? signedCheckpointResult.errorAt,
    errorMessage: verificationError,
    poswSkipped: skipPosw,
    signedCheckpoints: signedCheckpointResult,
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
