/**
 * 試験モード (ADR-0006) の暗号コア public surface
 */

export {
  canonicalizeStartToken,
  parseExamPackageManifest,
  parseExamPackageManifestResult,
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

export {
  EXAM_BUNDLE_SCHEMA,
  parseExamBundle,
  decodeExamPlaintext,
  encodeExamBundle,
  computeBundleProblemHash,
} from './examBundle.js';

export { matchExamStarter } from './examStarter.js';
export type { ExamStarterCheck, ExamStarterMatchResult, ExamStarterEventLike } from './examStarter.js';

export {
  CLASS_PACKAGE_SCHEMA,
  parseClassPackage,
  encodeClassPackage,
} from './classPackage.js';

export type {
  ExamDecryptResult,
  ExamPackageSigner,
  ExamPackageBuildInput,
  ExamPackageSignatureResult,
  ExamTimeBox,
  ExamBindingVerificationResult,
  ExamIdentifierName,
  ExamVerifiedIdentifiers,
  VerifyExamBindingOptions,
  BuildExamProofBlockInput,
  ExamManifestParseResult,
  ExamManifestRejectionCode,
} from './examPackage.js';
