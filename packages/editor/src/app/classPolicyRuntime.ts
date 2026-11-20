/**
 * 授業/課題で読み込んだ `.tcclass` の方針 (#645) を、動いているエディタの能力に当てる。
 *
 * 方針は 3 つの能力 (スクリーンショット・フルスクリーンの受動記録・export 前認証の best-effort) を決める。
 * 入口 (`/class` `/assignment`) の能力で起動した後に問題を読み込むので、ここで差分だけを切り替える:
 * - スクリーンショット: 撮らない方針になったら tracker を止めて外す (画面共有のバナー・ロック画面も消す)。
 *   撮る方針になったら画面共有の選択を出して tracker を始める (起動時と同じ選択。`startScreenShare` は main が渡す)
 * - フルスクリーンの受動記録: 始める / やめる (要求バナーは出さない。class と同じ)
 * - export 前認証: `ProofExporter.setPreExportBestEffort` を当て直す
 *
 * 当てた方針は `ClassPolicyStore` に保存し、リロード後の起動は main が同じ能力で始める
 * (`capabilitiesWithPolicy(mode, ClassPolicyStore.get())`)。方針の無い問題は入口の能力に戻す。
 * 問題のタブを作る**前に**呼ぶ (起動時と同じく、能力が決まってからタブに記録が始まる)。
 */

import type { ClassPolicy } from '@typedcode/shared';
import type { AppContext } from '../core/AppContext.js';
import { capabilitiesWithPolicy } from '../core/mode.js';
import { setCapabilityContract } from '../core/stateContract.js';
import { ClassPolicyStore } from '../services/ClassPolicyStore.js';

/** 方針を当てるのに要る AppContext の部分 (テストで差し替えられるように絞る) */
export type ClassPolicyContext = Pick<
  AppContext,
  'mode' | 'capabilities' | 'trackers' | 'proofExporter' | 'fullscreenTracker' | 'eventRecorder'
>;

export interface ClassPolicyRuntimeDeps {
  /** 画面共有の選択を出して screenshot tracker を始める (main の起動時と同じ選択) */
  startScreenShare: () => Promise<void>;
  /** 画面共有のバナーとロック画面を消す */
  hideScreenShareUi: () => void;
}

/** フルスクリーン状態の記録を始める (起動時と、記録する方針の問題を読み込んだとき) */
export function startFullscreenTracking(
  ctx: Pick<AppContext, 'capabilities' | 'fullscreenTracker' | 'eventRecorder'>
): void {
  ctx.fullscreenTracker.setRecordCallback((event) => {
    void ctx.eventRecorder?.recordToAllTabs(event);
  });
  ctx.fullscreenTracker.initialize(ctx.capabilities.fullscreenBanner);
}

/** スクリーンショットをやめる: tracker を止めて外し、以降に作るタブへ画面共有のオプトアウトを流し直さない */
function stopScreenshots(ctx: ClassPolicyContext, deps: ClassPolicyRuntimeDeps): void {
  const tracker = ctx.trackers.screenshot;
  if (tracker) {
    // 自分で止めるストリームの停止をロック画面にしない
    tracker.setStreamStoppedCallback(() => undefined);
    tracker.dispose();
  }
  ctx.trackers.screenshot = null;
  ctx.proofExporter.setScreenshotTracker(null);
  ctx.eventRecorder?.forgetSessionSnapshot('screenShareOptOut');
  deps.hideScreenShareUi();
}

/**
 * 読み込んだ問題の方針 (無ければ null = 入口の能力) を当てる。能力が変わらないものには触らない。
 */
export async function applyClassPolicy(
  ctx: ClassPolicyContext,
  policy: ClassPolicy | null,
  deps: ClassPolicyRuntimeDeps
): Promise<void> {
  const prev = ctx.capabilities;
  const next = capabilitiesWithPolicy(ctx.mode, policy);
  ClassPolicyStore.save(policy);
  ctx.capabilities = next;
  setCapabilityContract(next);
  ctx.proofExporter.setPreExportBestEffort(next.preExportBestEffort);

  if (prev.fullscreenTracking !== next.fullscreenTracking) {
    if (next.fullscreenTracking) startFullscreenTracking(ctx);
    else ctx.fullscreenTracker.dispose();
  }

  if (prev.screenshots && !next.screenshots) {
    stopScreenshots(ctx, deps);
  } else if (!prev.screenshots && next.screenshots && !ctx.trackers.screenshot) {
    await deps.startScreenShare();
  }
}
