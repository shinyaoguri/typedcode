/**
 * File parser utilities
 * Platform-agnostic functions for parsing ZIP and JSON files
 */

import JSZip from 'jszip';
import { arrayBufferToHex } from '../verification.js';
import type {
  ParsedFileData,
  ProofFileCore,
  ZipParseResult,
  FileParseCallbacks,
  ScreenshotManifest,
  ScreenshotManifestEntry,
} from './types.js';
import { getLanguageFromExtension, isBinaryFile } from './languageDetection.js';

// ============================================================================
// Type guards
// ============================================================================

/**
 * Check if data is a valid proof file
 */
export function isProofFile(data: unknown): data is ProofFileCore {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return 'proof' in obj && obj.proof !== null && typeof obj.proof === 'object';
}

// ============================================================================
// JSON parsing
// ============================================================================

/**
 * Parse JSON string as proof file
 * @param content - JSON string content
 * @param filename - Filename for language detection
 * @returns Parsed file data or null if not a valid proof file
 */
export function parseJsonString(
  content: string,
  filename: string
): ParsedFileData | null {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (isProofFile(parsed)) {
      return {
        filename,
        type: 'proof',
        language: parsed.language ?? 'unknown',
        rawData: content,
        proofData: parsed,
      };
    }

    // Not a proof file - return as plaintext JSON
    return {
      filename,
      type: 'plaintext',
      language: 'json',
      rawData: content,
    };
  } catch {
    // Parse error - return null
    return null;
  }
}

// ============================================================================
// ZIP parsing
// ============================================================================

/**
 * Parse ZIP buffer
 * @param buffer - ZIP file as ArrayBuffer
 * @param zipFilename - Original ZIP filename
 * @param callbacks - Optional progress callbacks
 * @returns ZIP parse result
 */
export async function parseZipBuffer(
  buffer: ArrayBuffer,
  zipFilename: string,
  callbacks?: FileParseCallbacks
): Promise<ZipParseResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);

    // Use ZIP filename as root folder name
    const rootFolderName = zipFilename.replace(/\.zip$/i, '');

    // Collect folder hierarchy
    const folderPathsSet = new Set<string>();

    // Extract all files
    const files: ParsedFileData[] = [];

    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) {
        // Record directory entry
        folderPathsSet.add(path.replace(/\/$/, ''));
        continue;
      }

      const filename = path.split('/').pop() ?? path;

      // Extract folder hierarchy from path
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        folderPathsSet.add(parts.slice(0, i).join('/'));
      }

      // Skip files in screenshots/ folder (processed separately)
      if (path.startsWith('screenshots/')) continue;

      // Skip binary files (text files only)
      if (isBinaryFile(filename)) continue;

      const content = await zipEntry.async('string');

      // For JSON files, check if it's a proof file
      if (filename.endsWith('.json')) {
        const parsed = parseJsonString(content, filename);
        if (parsed) {
          files.push({
            ...parsed,
            relativePath: path,
          });
        }
      } else {
        // Non-JSON files (C, TypeScript, Python, etc.)
        const language = getLanguageFromExtension(filename);
        files.push({
          filename,
          type: 'plaintext',
          language,
          rawData: content,
          relativePath: path,
        });
      }
    }

    callbacks?.onZipExtract?.(zipFilename, files.length);

    // Load screenshots
    const { screenshotManifest, screenshotBlobs } =
      await loadScreenshotsFromZip(zip, callbacks);

    if (files.length === 0 && (!screenshotManifest || screenshotManifest.screenshots.length === 0)) {
      return {
        success: false,
        files: [],
        error: 'ZIP contains no files.',
      };
    }

    // Calculate startTimestamp from first proof file
    let startTimestamp: number | undefined;
    const firstProof = files.find((f) => f.proofData);
    if (firstProof?.proofData) {
      const exportedAt = firstProof.proofData.metadata?.timestamp;
      const events = firstProof.proofData.proof?.events as { timestamp?: number }[] | undefined;
      if (exportedAt && events && events.length > 0) {
        const totalTime = events[events.length - 1]?.timestamp ?? 0;
        const exportTimestamp = new Date(exportedAt).getTime();
        startTimestamp = exportTimestamp - totalTime;
      }
    }

    return {
      success: true,
      files,
      rootFolderName,
      folderPaths: Array.from(folderPathsSet),
      screenshotManifest,
      screenshotBlobs,
      startTimestamp,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    callbacks?.onError?.(zipFilename, errorMessage);
    return {
      success: false,
      files: [],
      error: `Failed to read ZIP file: ${errorMessage}`,
    };
  }
}

/**
 * Load screenshots from ZIP file
 */
async function loadScreenshotsFromZip(
  zip: JSZip,
  callbacks?: FileParseCallbacks
): Promise<{
  screenshotManifest: ScreenshotManifest | undefined;
  screenshotBlobs: Map<string, ArrayBuffer> | undefined;
  verifiedCount: number;
}> {
  // Look for screenshots/manifest.json
  const manifestFile = zip.file('screenshots/manifest.json');
  if (!manifestFile) {
    return { screenshotManifest: undefined, screenshotBlobs: undefined, verifiedCount: 0 };
  }

  try {
    const manifestText = await manifestFile.async('string');
    const parsed = JSON.parse(manifestText);

    // Support both new format (object with version/screenshots) and legacy format (array)
    let manifest: ScreenshotManifest;
    if (Array.isArray(parsed)) {
      // Legacy format: array only
      manifest = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        totalScreenshots: parsed.length,
        screenshots: parsed as ScreenshotManifestEntry[],
      };
    } else {
      // New format: object
      manifest = parsed as ScreenshotManifest;
    }

    if (!manifest.screenshots || manifest.screenshots.length === 0) {
      return { screenshotManifest: manifest, screenshotBlobs: undefined, verifiedCount: 0 };
    }

    // Load screenshot binary data
    const screenshotBlobs = new Map<string, ArrayBuffer>();
    let verifiedCount = 0;

    for (const entry of manifest.screenshots) {
      const screenshotPath = `screenshots/${entry.filename}`;
      const screenshotFile = zip.file(screenshotPath);

      if (!screenshotFile) {
        continue;
      }

      const arrayBuffer = await screenshotFile.async('arraybuffer');

      // Verify hash
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const computedHash = arrayBufferToHex(hashBuffer);

      if (computedHash === entry.imageHash) {
        verifiedCount++;
        screenshotBlobs.set(entry.filename, arrayBuffer);
      }
    }

    callbacks?.onScreenshotLoad?.(manifest.screenshots.length, verifiedCount);

    return { screenshotManifest: manifest, screenshotBlobs, verifiedCount };
  } catch (error) {
    console.error('[parseZipBuffer] Failed to load screenshots:', error);
    return { screenshotManifest: undefined, screenshotBlobs: undefined, verifiedCount: 0 };
  }
}

/**
 * Extract first proof file from ZIP buffer
 * Simplified function for CLI use
 * @param buffer - ZIP file as ArrayBuffer
 * @returns Proof file data
 */
export async function extractFirstProofFromZip(
  buffer: ArrayBuffer
): Promise<ProofFileCore> {
  const zip = await JSZip.loadAsync(buffer);

  const jsonFiles = Object.keys(zip.files).filter(
    (name) => name.endsWith('.json') && !zip.files[name]?.dir
  );

  if (jsonFiles.length === 0) {
    throw new Error('No JSON proof file found in ZIP');
  }

  const jsonFileName = jsonFiles[0]!;
  const jsonFile = zip.files[jsonFileName];

  if (!jsonFile) {
    throw new Error(`Cannot read file: ${jsonFileName}`);
  }

  const jsonContent = await jsonFile.async('string');

  try {
    const proof = JSON.parse(jsonContent) as ProofFileCore;

    if (!proof.proof || !proof.typingProofHash) {
      throw new Error('Invalid proof file structure');
    }

    return proof;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${jsonFileName}: ${e.message}`);
    }
    throw e;
  }
}
