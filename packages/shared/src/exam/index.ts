/**
 * 試験モード (ADR-0006) の暗号コア public surface
 */

export {
  canonicalizeStartToken,
  parseExamPackageManifest,
  examPackageSigningCore,
  computeExamPackageHash,
  computeProblemContentHash,
  computeExamChainRoot,
  deriveExamKey,
  decryptExamPackage,
  buildExamPackage,
  verifyExamPackageSignature,
  verifyExamBinding,
  buildExamProofBlock,
  DEFAULT_EXAM_KDF_PARAMS,
} from './examPackage.js';

export type {
  ExamDecryptResult,
  ExamPackageSigner,
  ExamPackageBuildInput,
  ExamPackageSignatureResult,
  ExamTimeBox,
  ExamBindingVerificationResult,
  VerifyExamBindingOptions,
  BuildExamProofBlockInput,
} from './examPackage.js';
