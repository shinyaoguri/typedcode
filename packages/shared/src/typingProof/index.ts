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

// 記録キューの排出待ち (#225): 進捗ベースの待機ロジック (純関数)
export {
  waitForQueueDrain,
  DEFAULT_QUEUE_DRAIN_STALL_MS,
  DEFAULT_QUEUE_DRAIN_MAX_WAIT_MS,
  DEFAULT_QUEUE_DRAIN_POLL_MS,
} from './queueDrain.js';
export type { QueueDrainOptions, QueueDrainResult, QueueDrainProbe, QueueDrainReason } from './queueDrain.js';

// 入力タイプ検証ユーティリティ
export {
  isAllowedInputType,
  isProhibitedInputType,
  getAllowedInputTypes,
  getProhibitedInputTypes,
  validateEventType,
  validateInputType,
} from './InputTypeValidator.js';
