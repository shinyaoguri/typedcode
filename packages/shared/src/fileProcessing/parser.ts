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
// ZIP 展開の DoS ガード (zip bomb)
// ============================================================================

/** 全エントリの解凍後合計サイズ上限 (bytes)。正規 proof (スクショ込み) でも十分余裕がある。 */
const MAX_ZIP_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024; // 256 MB
/** エントリ数上限。 */
const MAX_ZIP_ENTRIES = 5000;

/**
 * 高圧縮率の悪意ある ZIP (zip bomb) で grader / 検証 UI を OOM/ハングさせないための事前ガード。
 * `JSZip.loadAsync` は解凍前のメタデータを持つので、エントリの解凍後サイズ合計を**展開前に**
 * 検査して上限超過なら throw する。
 *
 * parser 内の各エントリポイントが呼ぶほか、shared を経由せず JSZip を直接使う消費者
 * (verify の ZipFileProcessor 等) も loadAsync 直後に必ず呼ぶこと (#149)。
 */
export function assertZipWithinBudget(zip: JSZip): void {
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP has too many entries (${names.length} > ${MAX_ZIP_ENTRIES})`);
  }
  let total = 0;
  for (const name of names) {
    // `_data.uncompressedSize` は JSZip 内部だが安定。未取得なら 0 として扱う (エントリ数で別途上限)。
    const f = zip.files[name] as unknown as { _data?: { uncompressedSize?: number } };
    total += f?._data?.uncompressedSize ?? 0;
    if (total > MAX_ZIP_TOTAL_UNCOMPRESSED) {
      throw new Error(
        `ZIP uncompressed size exceeds limit (${MAX_ZIP_TOTAL_UNCOMPRESSED} bytes)`
      );
    }
  }
}

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
    assertZipWithinBudget(zip);

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
 * ZIP から `screenshots/manifest.json` の entry 群と画像バイト列を取り出す (#147)。
 *
 * ここでは**検証しない** — 判定 (ハッシュ突合・チェーン裏付け) は
 * `screenshotVerification.ts` の `summarizeScreenshotArtifacts` に委譲する。
 * - manifest 自体が無い → null (スクショ無しセッション / 旧 export / JSON 単体)
 * - manifest が壊れている / 形式不正 → `entries: []` (チェーンに記録があれば
 *   chainOnly として浮くように、「無かった」と同一視しない)
 */
export async function extractScreenshotArtifactsFromZip(buffer: ArrayBuffer): Promise<{
  entries: Array<{ filename: string; imageHash: string }>;
  images: Map<string, ArrayBuffer>;
} | null> {
  const zip = await JSZip.loadAsync(buffer);
  assertZipWithinBudget(zip);

  const manifestFile = zip.file('screenshots/manifest.json');
  if (!manifestFile) return null;

  let rawEntries: unknown = [];
  try {
    const parsed: unknown = JSON.parse(await manifestFile.async('string'));
    rawEntries = Array.isArray(parsed)
      ? parsed
      : ((parsed as { screenshots?: unknown } | null)?.screenshots ?? []);
  } catch {
    rawEntries = [];
  }

  const entries: Array<{ filename: string; imageHash: string }> = [];
  if (Array.isArray(rawEntries)) {
    for (const e of rawEntries) {
      const filename = (e as { filename?: unknown } | null)?.filename;
      const imageHash = (e as { imageHash?: unknown } | null)?.imageHash;
      if (typeof filename === 'string' && typeof imageHash === 'string') {
        entries.push({ filename, imageHash });
      }
    }
  }

  const images = new Map<string, ArrayBuffer>();
  for (const entry of entries) {
    const file = zip.file(`screenshots/${entry.filename}`);
    if (!file) continue;
    images.set(entry.filename, await file.async('arraybuffer'));
  }

  return { entries, images };
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
  assertZipWithinBudget(zip);

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

/**
 * ZIP 内の **すべて** の proof JSON を構造で選別して返す (verify-cli の offline grader 用)。
 *
 * exam/class モードはタブ毎に独立した `<name>_proof.json` を N 個出力するため、grader は
 * 全件を検証しなければならない。最初の 1 件だけ見る `extractFirstProofFromZip` では、
 * 残りのタブ (AI 貼付・偽造され得る) が未検証のまま exit 0 で通ってしまう。
 *
 * - proof 判定は **構造** (`isProofFile`) で行う (ファイル名順や位置に依存しない。
 *   `screenshots/manifest.json` のような非 proof JSON が先頭に来ても誤選択しない)。
 * - `screenshots/` 配下は除外する。
 * - ファイル名昇順で決定的に返す。
 */
export async function extractAllProofsFromZip(
  buffer: ArrayBuffer
): Promise<Array<{ filename: string; proof: ProofFileCore }>> {
  const zip = await JSZip.loadAsync(buffer);
  assertZipWithinBudget(zip);
  const jsonNames = Object.keys(zip.files)
    .filter(
      (name) =>
        name.endsWith('.json') &&
        !zip.files[name]?.dir &&
        !name.startsWith('screenshots/')
    )
    .sort();

  const proofs: Array<{ filename: string; proof: ProofFileCore }> = [];
  for (const name of jsonNames) {
    const file = zip.files[name];
    if (!file) continue;
    const content = await file.async('string');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue; // 壊れた / 非 JSON はスキップ (proof ではない)
    }
    if (isProofFile(parsed)) {
      proofs.push({ filename: name, proof: parsed as ProofFileCore });
    }
  }
  return proofs;
}
