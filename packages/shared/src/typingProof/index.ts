/**
 * TypingProof モジュール
 * ハッシュチェーン管理、PoSW計算、検証ロジックを提供
 */

// メインクラス
export { TypingProof } from './TypingProof.js';

// 内部マネージャー（必要に応じてエクスポート）
export { HashChainManager } from './HashChainManager.js';
export { PoswManager } from './PoswManager.js';
export { CheckpointManager } from './CheckpointManager.js';
export { ChainVerifier } from './ChainVerifier.js';
export { StatisticsCalculator } from './StatisticsCalculator.js';

// 入力タイプ検証ユーティリティ
export {
  isAllowedInputType,
  isProhibitedInputType,
  getAllowedInputTypes,
  getProhibitedInputTypes,
  validateEventType,
  validateInputType
} from './InputTypeValidator.js';
