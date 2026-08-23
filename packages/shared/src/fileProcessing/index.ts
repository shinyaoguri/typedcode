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
} from './languageDetection.js';

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
