/**
 * タブ単位のスクショ集計 (#213)。
 *
 * CLI が出す剥ぎ取り warning (`screenshots may have been stripped`) と同じ結論を
 * web でも出すための軸が `chainOnly`。ここが 0 に潰れると、`screenshots/` を丸ごと
 * 削除した提出物が web では警告ゼロで通る。
 */

import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '@typedcode/shared';
import { summarizeTabScreenshots } from '../screenshotSummary.js';
import type { VerifyScreenshot } from '../../types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function chainWithScreenshots(...imageHashes: string[]): StoredEvent[] {
  return imageHashes.map((imageHash, i) => ({
    sequence: i + 1,
    type: 'screenshotCapture',
    timestamp: i * 10,
    data: { imageHash },
  })) as unknown as StoredEvent[];
}

function screenshot(overrides: Partial<VerifyScreenshot> & { imageHash: string }): VerifyScreenshot {
  return {
    id: `ss-${overrides.imageHash.slice(0, 4)}`,
    filename: 'shot.webp',
    captureType: 'periodic',
    eventSequence: 1,
    timestamp: 0,
    imageUrl: null,
    imageBlob: null,
    verified: true,
    missing: false,
    tampered: false,
    displayInfo: {},
    fileSizeBytes: 0,
    ...overrides,
  } as VerifyScreenshot;
}

describe('summarizeTabScreenshots', () => {
  it('reports screenshots recorded in the chain but absent from the manifest as chainOnly', () => {
    const summary = summarizeTabScreenshots({
      screenshots: [screenshot({ imageHash: HASH_A })],
      events: chainWithScreenshots(HASH_A, HASH_B),
    });

    expect(summary?.chainOnly).toBe(1);
  });

  it('reports every chain screenshot as chainOnly when the whole screenshots folder is stripped', () => {
    const summary = summarizeTabScreenshots({ screenshots: [], events: chainWithScreenshots(HASH_A, HASH_B) });

    expect(summary).toEqual({ total: 0, verified: 0, missing: 0, tampered: 0, chainOnly: 2 });
  });

  it('raises no chainOnly for an intact export', () => {
    const summary = summarizeTabScreenshots({
      screenshots: [screenshot({ imageHash: HASH_A }), screenshot({ imageHash: HASH_B })],
      events: chainWithScreenshots(HASH_A, HASH_B),
    });

    expect(summary).toEqual({ total: 2, verified: 2, missing: 0, tampered: 0, chainOnly: 0 });
  });

  it('distinguishes "not checked" (no screenshots supplied) from a session with zero screenshots', () => {
    expect(summarizeTabScreenshots({ events: chainWithScreenshots(HASH_A) })).toBeUndefined();
    expect(summarizeTabScreenshots({ screenshots: [], events: [] })).toEqual({
      total: 0,
      verified: 0,
      missing: 0,
      tampered: 0,
      chainOnly: 0,
    });
  });

  it('counts missing and tampered images without letting them count as verified', () => {
    const summary = summarizeTabScreenshots({
      screenshots: [
        screenshot({ imageHash: HASH_A }),
        screenshot({ imageHash: HASH_B, verified: false, missing: true }),
        screenshot({ imageHash: HASH_A, verified: true, tampered: true }),
      ],
      events: chainWithScreenshots(HASH_A, HASH_B),
    });

    expect(summary).toEqual({ total: 3, verified: 1, missing: 1, tampered: 1, chainOnly: 0 });
  });
});
