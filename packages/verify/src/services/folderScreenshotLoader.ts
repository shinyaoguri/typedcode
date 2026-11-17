/**
 * フォルダ (File System Access API) 経路のスクリーンショット読込 (#212)。
 *
 * ZIP 経路 (`ZipFileProcessor`) と **同じ材料**でスクショを検証するための層:
 *
 * 1. フォルダ内の proof からチェーンの `screenshotCapture.imageHash` 集合を集める
 *    (`collectFolderChainImageHashes`)
 * 2. その集合を `ScreenshotService.loadFromFolder` に渡す (`loadFolderScreenshots`)
 *
 * 渡し忘れると `isChainBackedImageHash` が常に true に退化し、判定が「画像の SHA-256 ==
 * manifest の imageHash」だけになる。manifest は未署名なので画像とセットで差し替え可能 =
 * 「ZIP で開くと改竄・フォルダで開くと緑」という提出物依存の結論のブレになる (#212)。
 */

import { collectChainImageHashes, type StoredEvent } from '@typedcode/shared';
import type { FSAccessFileEntry, ProofFile, VerifyScreenshot } from '../types.js';
import { isNotFound } from './fsaErrors.js';
import { ScreenshotService } from './ScreenshotService.js';
import { normalizeScreenshotManifest } from './screenshotManifest.js';

export interface FolderScreenshotLoadResult {
  /** manifest 由来のスクショ一覧。**空配列 = コンテナはあったが manifest entry 0** (未検査ではない)。 */
  screenshots: VerifyScreenshot[];
  startTimestamp?: number;
  /** 画像を保持するサービス (manifest が無ければ undefined)。 */
  screenshotService?: ScreenshotService;
}

/**
 * フォルダ内の proof (`*.json`) から、チェーンに焼かれた screenshot ハッシュ集合を集める。
 * 実体は shared (`collectChainImageHashes`) — ZIP 経路と同一実装。
 */
export async function collectFolderChainImageHashes(
  files: readonly FSAccessFileEntry[],
  /** `strict`: 読み取りの失敗を無視せず投げる (読めなかった proof のハッシュが集合から抜けたまま判定しない。#703) */
  options: { strict?: boolean } = {}
): Promise<Set<string>> {
  const eventsList: StoredEvent[][] = [];

  for (const entry of files) {
    if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.json')) continue;
    // screenshots/manifest.json 等は proof ではない
    if (entry.path.startsWith('screenshots/')) continue;

    let text: string;
    try {
      text = await (await entry.handle.getFile()).text();
    } catch (error) {
      // 読めないファイルは無視 (strict のときは失敗にする)
      if (options.strict) throw error;
      continue;
    }
    try {
      const parsed = JSON.parse(text) as ProofFile;
      const events = parsed?.proof?.events;
      if (Array.isArray(events)) eventsList.push(events);
    } catch {
      // proof ではない JSON は無視
    }
  }

  return collectChainImageHashes(eventsList);
}

/**
 * `screenshots/` を読み、チェーン裏付け込みで検証する。
 *
 * screenshots フォルダや manifest が無い場合も **空配列**を返す (null ではない):
 * 「コンテナは受け取ったがスクショが 1 枚も無い」= 剥ぎ取りの可能性を chainOnly で
 * 検出させるため。ZIP 経路 (manifest 不在でも `screenshots: []` を返す) と同じ扱い。
 */
export async function loadFolderScreenshots(
  rootHandle: FileSystemDirectoryHandle,
  chainImageHashes: ReadonlySet<string>,
  /**
   * `strict`: 読み取りの失敗 (画像・manifest が一時的に読めない) を「無い」と見ず投げる (#703)。
   * screenshots フォルダ・manifest.json・画像が本当に無い (`NotFoundError`) ときは従来どおり 0 枚 / 欠損として扱う
   */
  options: { strict?: boolean } = {}
): Promise<FolderScreenshotLoadResult> {
  const strict = options.strict ?? false;
  try {
    let screenshotsFolderHandle: FileSystemDirectoryHandle;
    let manifestText: string;
    try {
      screenshotsFolderHandle = await rootHandle.getDirectoryHandle('screenshots');
      const manifestHandle = await screenshotsFolderHandle.getFileHandle('manifest.json');
      manifestText = await (await manifestHandle.getFile()).text();
    } catch (error) {
      // screenshots フォルダ / manifest.json が無い (strict のときは、無い以外の読み取りの失敗を投げる)
      if (strict && !isNotFound(error)) throw error;
      return { screenshots: [] };
    }

    let manifest: ReturnType<typeof normalizeScreenshotManifest>;
    try {
      manifest = normalizeScreenshotManifest(JSON.parse(manifestText));
    } catch {
      // manifest が JSON として壊れている (読み取りの失敗ではない)
      return { screenshots: [] };
    }
    if (!manifest || manifest.screenshots.length === 0) {
      return { screenshots: [] };
    }

    const screenshotService = new ScreenshotService();
    const screenshots = await screenshotService.loadFromFolder(screenshotsFolderHandle, manifest, chainImageHashes, {
      strict,
    });

    return {
      screenshots,
      startTimestamp: calculateStartTimestamp(screenshots, manifest.exportedAt),
      screenshotService,
    };
  } catch (error) {
    if (strict) throw error;
    // 読めない
    return { screenshots: [] };
  }
}

/** エクスポート時刻から最後のスクショの相対時刻を引いて記録開始時刻を推定する。 */
function calculateStartTimestamp(screenshots: readonly VerifyScreenshot[], exportedAt: string): number | undefined {
  if (screenshots.length === 0) return undefined;
  const lastTimestamp = screenshots.reduce((max, s) => Math.max(max, s.timestamp), 0);
  const exportedAtMs = new Date(exportedAt).getTime();
  return Number.isNaN(exportedAtMs) ? undefined : exportedAtMs - lastTimestamp;
}
