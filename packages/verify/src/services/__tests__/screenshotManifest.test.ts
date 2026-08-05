/**
 * `screenshots/manifest.json` の正規化 (#212)。
 *
 * ZIP 経路とフォルダ経路で同じパースを通すための単一実装。壊れた / 旧形式の manifest で
 * 例外を投げると、外側の catch でスクショが黙って 0 件になり「検査したように見えて
 * 何も検査していない」状態になる。
 */

import { describe, expect, it } from 'vitest';
import { normalizeScreenshotManifest } from '../screenshotManifest.js';

describe('normalizeScreenshotManifest', () => {
  it('accepts the current object form as-is', () => {
    const manifest = normalizeScreenshotManifest({
      version: '2.0',
      exportedAt: '2026-08-05T00:00:00.000Z',
      totalScreenshots: 1,
      screenshots: [{ filename: 'a.webp', imageHash: 'a'.repeat(64) }],
    });

    expect(manifest?.version).toBe('2.0');
    expect(manifest?.screenshots).toHaveLength(1);
  });

  it('accepts the legacy array form (entries only)', () => {
    const manifest = normalizeScreenshotManifest([{ filename: 'a.webp', imageHash: 'a'.repeat(64) }]);

    expect(manifest?.screenshots).toHaveLength(1);
    expect(manifest?.totalScreenshots).toBe(1);
  });

  it('yields an empty screenshot list instead of throwing when the screenshots field is absent', () => {
    expect(normalizeScreenshotManifest({ version: '1.0' })?.screenshots).toEqual([]);
  });

  it('rejects values that are not a manifest at all', () => {
    expect(normalizeScreenshotManifest(null)).toBeNull();
    expect(normalizeScreenshotManifest('manifest')).toBeNull();
    expect(normalizeScreenshotManifest(42)).toBeNull();
  });
});
