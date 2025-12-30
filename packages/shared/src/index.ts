/**
 * @typedcode/shared - 共有モジュール
 */

// 型定義
export * from './types.js';

// タイピング証明
export { TypingProof } from './typingProof.js';

// フィンガープリント
export { Fingerprint } from './fingerprint.js';

// 検証ユーティリティ
export {
  deterministicStringify,
  arrayBufferToHex,
  computeHash,
  verifyPoSW,
  verifyTypingProofHash,
  verifyChain,
  verifyProofFile,
} from './verification.js';

export type {
  ProofFile,
  FullVerificationResult,
  VerificationProgressCallback,
} from './verification.js';
