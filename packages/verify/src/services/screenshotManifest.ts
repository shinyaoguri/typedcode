/**
 * `screenshots/manifest.json` の正規化 (#212)。
 *
 * ZIP 経路とフォルダ経路で **同じパース**を通すための単一実装。以前はフォルダ側だけ
 * 旧形式 (配列) を扱わず `manifest.screenshots` 欠落で例外を投げ、外側の catch で
 * スクショが黙って 0 件になっていた (= 検査したように見えて何も検査していない)。
 */

import type { ScreenshotManifest, ScreenshotManifestEntry } from '../types.js';

/**
 * 新形式 (`{ version, exportedAt, totalScreenshots, screenshots }`) と
 * 旧形式 (entry の配列) の両方を受け付け、`screenshots` が必ず配列の manifest にする。
 * manifest として解釈できない場合は `null`。
 */
export function normalizeScreenshotManifest(parsed: unknown): ScreenshotManifest | null {
  if (Array.isArray(parsed)) {
    // 旧形式: entry の配列のみ
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      totalScreenshots: parsed.length,
      screenshots: parsed as ScreenshotManifestEntry[],
    };
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const raw = parsed as Partial<ScreenshotManifest>;
  const screenshots = Array.isArray(raw.screenshots) ? raw.screenshots : [];

  return {
    version: typeof raw.version === 'string' ? raw.version : '1.0',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    totalScreenshots: typeof raw.totalScreenshots === 'number' ? raw.totalScreenshots : screenshots.length,
    screenshots,
  };
}
