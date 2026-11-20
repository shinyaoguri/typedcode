// 仕様別の検証 (#809 / ADR-0053)。型名は内部用で、公開する名前は #811 で確定する
export { verifyProofBySpec } from './verifyProofBySpec.js';
export { identifyProofSpec, isLegacyTypingProofStructure } from './identify.js';
export { SPEC_RESULT_SCHEMA } from './types.js';
export type {
  SpecId,
  SpecTrustInput,
  SpecVerificationContext,
  SpecSupportStatus,
  SpecSupportCode,
  SpecDeclaredIdentifier,
  SpecSupport,
  SpecCheckStatus,
  SpecCheckCode,
  SpecCheck,
  SpecChecks,
  SpecLimitationCode,
  SpecKeyRole,
  SpecTrustedKey,
  SpecTrustResult,
  SpecIntegrity,
  LegacyTypingProofDetail,
  SpecVerificationResult,
} from './types.js';
