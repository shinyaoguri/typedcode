/**
 * Services module - ビジネスロジックサービス
 *
 * 外部API呼び出しやファイル処理などのサービスを提供します。
 */

export { FileProcessor } from './FileProcessor.js';
export type {
  ParsedFileData,
  FileProcessResult,
  FileProcessCallbacks,
} from './FileProcessor.js';

export {
  formatTypingTime,
  calculateTypingSpeed,
  countPasteEvents,
  calculateChartStats,
  buildResultData,
} from './ResultDataService.js';
export type { ChartStats } from './ResultDataService.js';

