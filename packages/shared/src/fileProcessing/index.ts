/**
 * File processing module
 * Platform-agnostic file processing utilities
 */

// Types
export type {
  FileType,
  ParsedFileData,
  ProofFileCore,
  ZipParseResult,
  FileParseCallbacks,
  ScreenshotManifest,
  ScreenshotManifestEntry,
} from './types.js';

// Language detection
export {
  getLanguageFromExtension,
  isBinaryFile,
  getFileType,
  isProofFilename,
  KNOWN_LANGUAGES,
} from './languageDetection.js';

// proof 由来の自己申告言語の入力検証 (#248)
export { normalizeProofLanguage, UNKNOWN_LANGUAGE } from './proofLanguage.js';

// ZIP 展開予算 (#234)
export {
  ZipExtractionBudget,
  ZipBudgetExceededError,
  readZipEntryBytes,
  readZipEntryText,
  assertZipWithinBudget,
  MAX_ZIP_TOTAL_UNCOMPRESSED,
  MAX_ZIP_ENTRIES,
} from './zipBudget.js';

// Parser
export {
  isProofFile,
  parseJsonString,
  parseZipBuffer,
  extractFirstProofFromZip,
  extractAllProofsFromZip,
  extractScreenshotArtifactsFromZip,
} from './parser.js';
