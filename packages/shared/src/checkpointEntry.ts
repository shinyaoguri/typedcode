/**
 * Workers / Node tooling 向け checkpoint 専用エントリ。
 *
 * shared の index.ts は browser-only な依存 (Worker, document など) を含むので、
 * Cloudflare Workers / Node スクリプトから import すると tsc が DOM 型の不在で
 * エラーになる。このエントリは checkpoint 関連の DOM-non-dependent な部分だけを
 * 再エクスポートする。
 */

export {
  hashSignedCheckpointPayload,
  resolveCheckpointPublicKey,
  verifyCheckpointSignature,
  verifySignedCheckpoints,
  verifyProofSignedCheckpoints,
  createSignedCheckpointEnvelope,
  validateSignedCheckpointInput,
  isIdempotentSigningRetry,
} from './signedCheckpoints.js';

export type {
  SignedCheckpointInput,
  SignedCheckpointServerContext,
  SignedCheckpointSigner,
} from './signedCheckpoints.js';

export {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
} from './checkpointKeys/index.js';

export type {
  CheckpointPublicKey,
  CheckpointPublicKeyStatus,
} from './checkpointKeys/index.js';

export {
  POSW_ITERATIONS,
  SIGNED_CHECKPOINT_FORMAT_VERSION,
} from './version.js';

export {
  deterministicStringify,
  computeHash,
  arrayBufferToHex,
} from './utils/hashUtils.js';

export type {
  SignedCheckpointPayload,
  SignedCheckpointEnvelope,
  SignedCheckpointVerificationDetail,
  SignedCheckpointsVerificationResult,
  SignedCheckpointAlgorithm,
} from './types/signedCheckpoint.js';
