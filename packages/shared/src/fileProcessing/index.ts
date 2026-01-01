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

// Parser
export {
  isProofFile,
  parseJsonString,
  parseZipBuffer,
  extractFirstProofFromZip,
} from './parser.js';
