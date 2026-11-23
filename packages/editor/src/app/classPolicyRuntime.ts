/**
 * フルスクリーン状態の記録の配線 (ADR-0008/0014、能力 fullscreenTracking)。
 *
 * `.tcclass` の方針 (#645) は、読み込んだ配布物の作業スペース (#646) の起動時に能力として決まる
 * (`core/mode.ts` の `capabilitiesWithPolicy`)。動いているページの能力を途中で切り替える経路は持たない:
 * 方針の違う配布物は別の作業スペースになり、ページごと移る (main.ts の `runClassLoad`)。
 */

import type { AppContext } from '../core/AppContext.js';

/** フルスクリーン状態の記録を始める (起動時) */
export function startFullscreenTracking(
  ctx: Pick<AppContext, 'capabilities' | 'fullscreenTracker' | 'eventRecorder'>
): void {
  ctx.fullscreenTracker.setRecordCallback((event) => {
    void ctx.eventRecorder?.recordToAllTabs(event);
  });
  ctx.fullscreenTracker.initialize(ctx.capabilities.fullscreenBanner);
}
