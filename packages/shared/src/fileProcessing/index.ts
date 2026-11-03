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
  isProofExportFilename,
  extractScreenshotArtifactsFromZip,
  extractSubmissionSourcesFromZip,
} from './parser.js';
export type { ProofExtractionFailure, ProofExtractionFailureReason, ProofExtractionResult } from './parser.js';

// export ZIP のファイル名の付け方 (editor と提出物検証の共有仕様, #293)
export {
  LANGUAGE_FILE_EXTENSIONS,
  FALLBACK_FILE_EXTENSION,
  fileExtensionForLanguage,
  withLanguageExtension,
  proofBaseName,
  createExportNamer,
  planExportFilenames,
} from './exportNaming.js';
export type { ExportTabName, ExportFilenames } from './exportNaming.js';

// 提出物 (ZIP) の対応規則と照合 (#293)
export { matchSubmissionSources, isSubmissionSourceEntry, submissionSeverity } from './submissionSources.js';
export type {
  SubmissionProofInput,
  SubmissionSourceInput,
  MatchSubmissionSourcesInput,
  SubmissionPairStatus,
  SubmissionMismatchDetail,
  SubmissionPair,
  SubmissionReport,
  SubmissionSeverity,
} from './submissionSources.js';
