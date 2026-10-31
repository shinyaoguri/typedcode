/**
 * ライトボックスの解像度表示 (#281 v4)。displayInfo は manifest 由来で欠けうる
 * (旧形式・破損) ので、`undefined x undefined` を出さず '-' に落とす。
 */

import { describe, expect, it } from 'vitest';
import { formatScreenshotResolution } from '../ScreenshotLightbox.js';

describe('formatScreenshotResolution', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a non-numeric width', { width: 'x', height: 1 }],
    ['a NaN width', { width: Number.NaN, height: 1 }],
  ])('shows a dash instead of "undefined x undefined" for %s', (_label, displayInfo) => {
    expect(formatScreenshotResolution(displayInfo)).toBe('-');
  });

  it('formats a valid width and height', () => {
    expect(formatScreenshotResolution({ width: 1920, height: 1080 })).toBe('1920 x 1080');
  });
});
