/**
 * ScreenshotTracker.handleCapture のテスト (#503)。
 *
 * export ZIP の manifest に入るスクリーンショットは、必ずチェーン上の screenshotCapture に
 * 裏付けられていなければならない (verifier の isChainBackedImageHash が見張る)。
 * callback (チェーンへの記録先) が無いときに画像だけ保存すると裏付けの無い画像が残るので、
 * 保存の前に捨てる。キャプチャ・ストレージ・UI は本題でないのでモックする。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DisplayInfo } from '@typedcode/shared';

const save = vi.fn<(screenshot: unknown) => Promise<string>>();

vi.mock('../../services/ScreenCaptureService.js', () => ({
  ScreenCaptureService: class {
    static isSupported(): boolean {
      return true;
    }
  },
}));
vi.mock('../../services/ScreenshotStorageService.js', () => ({
  ScreenshotStorageService: class {
    save = save;
  },
}));
vi.mock('../../ui/components/ScreenShareGuide.js', () => ({
  ScreenShareGuide: class {},
}));
vi.mock('../../i18n/index.js', () => ({
  t: (): string | undefined => undefined,
}));

import { ScreenshotTracker, type ScreenshotTrackerEvent } from '../ScreenshotTracker.js';
import type { SessionStorageService } from '../../services/SessionStorageService.js';

const displayInfo: DisplayInfo = { width: 1920, height: 1080, devicePixelRatio: 1 };

/** private な handleCapture を ScreenCaptureService の撮影コールバックと同じ引数で呼ぶ */
async function capture(tracker: ScreenshotTracker): Promise<void> {
  const handle = (
    tracker as unknown as {
      handleCapture(b: Blob, h: string, t: 'periodic', d: DisplayInfo): Promise<void>;
    }
  ).handleCapture.bind(tracker);
  await handle(new Blob(['x']), 'a'.repeat(64), 'periodic', displayInfo);
}

describe('ScreenshotTracker.handleCapture', () => {
  beforeEach(() => {
    save.mockReset();
    save.mockResolvedValue('storage-key');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('does not save the screenshot when no callback is set, so no image exists without a chain event', async () => {
    const tracker = new ScreenshotTracker({} as SessionStorageService);

    await capture(tracker);

    expect(save).not.toHaveBeenCalled();
  });

  it('saves the screenshot and emits exactly one screenshotCapture event when a callback is set', async () => {
    const tracker = new ScreenshotTracker({} as SessionStorageService);
    const events: ScreenshotTrackerEvent[] = [];
    tracker.setCallback((e) => events.push(e));

    await capture(tracker);

    expect(save).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('screenshotCapture');
  });
});
