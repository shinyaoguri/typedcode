/**
 * Core module - 検証ロジックの中核機能
 *
 * このモジュールはUIに依存しない純粋な検証ロジックを提供します。
 */

export { VerificationEngine } from './VerificationEngine.js';
export type {
  MetadataVerificationResult,
  ChainVerificationResult,
  AttestationInfo,
  VerificationEngineResult,
} from './VerificationEngine.js';

export {
  createVerifyContext,
  getOrCreateChartCache,
  deleteChartCache,
  clearAllChartCaches,
  isMultiFileModeInitialized,
} from './VerifyContext.js';
export type {
  VerifyContext,
  VerifyAppConfig,
  TabChartCache,
} from './VerifyContext.js';
