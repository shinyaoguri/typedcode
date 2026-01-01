/**
 * File processing types
 * Platform-agnostic type definitions for file processing
 */

import type { DisplayInfo, ScreenshotCaptureType } from '../types.js';

// ============================================================================
// File types
// ============================================================================

/** File type */
export type FileType = 'proof' | 'plaintext';

/** Parsed file data */
export interface ParsedFileData {
  /** Filename */
  filename: string;
  /** File type */
  type: FileType;
  /** Language (for proof: verified language, for plaintext: inferred from extension) */
  language: string;
  /** Raw data (string) */
  rawData: string;
  /** Parsed data (for proof files only) */
  proofData?: ProofFileCore;
  /** Relative path within folder */
  relativePath?: string;
}

/** Core proof file structure (platform-agnostic) */
export interface ProofFileCore {
  proof?: {
    events?: unknown[];
  };
  language?: string;
  content?: string;
  typingProofHash?: string;
  metadata?: {
    timestamp?: string;
  };
}

// ============================================================================
// ZIP processing types
// ============================================================================

/** ZIP parse result */
export interface ZipParseResult {
  /** Success flag */
  success: boolean;
  /** Parsed files */
  files: ParsedFileData[];
  /** Error message (on failure) */
  error?: string;
  /** Root folder name from ZIP filename */
  rootFolderName?: string;
  /** Folder paths within ZIP */
  folderPaths?: string[];
  /** Screenshot manifest (if present) */
  screenshotManifest?: ScreenshotManifest;
  /** Screenshot binary data (platform-neutral) */
  screenshotBlobs?: Map<string, ArrayBuffer>;
  /** Recording start timestamp (for chart X-axis) */
  startTimestamp?: number;
}

/** Processing callbacks */
export interface FileParseCallbacks {
  /** File read started */
  onReadStart?: (filename: string) => void;
  /** File read completed */
  onReadComplete?: (filename: string, sizeKb: number) => void;
  /** JSON parse completed */
  onParseComplete?: (filename: string, eventCount: number) => void;
  /** ZIP extraction progress */
  onZipExtract?: (filename: string, fileCount: number) => void;
  /** Screenshot loading */
  onScreenshotLoad?: (count: number, verifiedCount: number) => void;
  /** Error occurred */
  onError?: (filename: string, error: string) => void;
}

// ============================================================================
// Screenshot types (platform-agnostic)
// ============================================================================

/** Screenshot manifest entry */
export interface ScreenshotManifestEntry {
  index: number;
  filename: string;
  imageHash: string;
  captureType: ScreenshotCaptureType;
  eventSequence: number;
  timestamp: number;
  createdAt: number;
  displayInfo: DisplayInfo;
  fileSizeBytes: number;
}

/** Screenshot manifest */
export interface ScreenshotManifest {
  version: string;
  exportedAt: string;
  totalScreenshots: number;
  screenshots: ScreenshotManifestEntry[];
}
