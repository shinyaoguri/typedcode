/**
 * タブ 1 件分のスクリーンショット検証サマリを導く純関数 (#213)。
 *
 * per-image の判定 (ハッシュ突合 + チェーン裏付け) は読込時に shared の `checkScreenshotImage`
 * が済ませている。ここが足すのは **剥ぎ取り軸 (`chainOnly`)** — チェーンには記録があるのに
 * manifest 側に entry が無い imageHash の数で、manifest ごと消されても検出できる唯一の軸。
 * 数え方は shared の `countChainOnlyImageHashes` に委譲する (verify-cli と同一実装)。
 */

import { collectChainImageHashes, countChainOnlyImageHashes, type StoredEvent } from '@typedcode/shared';
import type { ScreenshotVerificationSummary, VerifyScreenshot } from '../types.js';

export interface TabScreenshotSummaryInput {
  /**
   * このタブに紐づくスクリーンショット (ZIP / フォルダの manifest 由来)。
   * **`undefined` は「未検査」** (proof.json 単体投入で screenshots/ を伴わない) を意味し、
   * 空配列 (= コンテナはあるが manifest entry が 0) とは区別する。
   */
  screenshots?: VerifyScreenshot[];
  /** このタブの proof のイベント列。screenshotCapture.imageHash が真正なハッシュ集合。 */
  events?: readonly StoredEvent[];
}

/**
 * 未検査なら `undefined` を返す (CLI の `screenshots === undefined` と同じ意味付け:
 * 「スクショ 0 枚のセッション」と混同すると overclaim になる)。
 */
export function summarizeTabScreenshots(input: TabScreenshotSummaryInput): ScreenshotVerificationSummary | undefined {
  const { screenshots, events } = input;
  if (!screenshots) return undefined;

  const chainImageHashes = collectChainImageHashes(events ? [events] : []);

  return {
    total: screenshots.length,
    verified: screenshots.filter((s) => s.verified && !s.missing && !s.tampered).length,
    missing: screenshots.filter((s) => s.missing).length,
    tampered: screenshots.filter((s) => s.tampered).length,
    chainOnly: countChainOnlyImageHashes(screenshots, chainImageHashes),
  };
}
