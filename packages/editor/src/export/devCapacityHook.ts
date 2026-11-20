/**
 * export の容量の測定 (#628) 専用のフック `window.__tcTestCapacity` (dev ビルドのみ)。
 *
 * アクティブなタブの、実際の打鍵で記録したイベント列を `buildCapacityPadding` で指定の件数まで水増しし、
 * メモリ上の TypingProof に差し込む。そのあと画面の「ダウンロード」を押せば、本物の `ProofExporter` の経路
 * (exportProof → `JSON.stringify(proofWithContent, null, 2)` → JSZip) がその件数の proof を書き出す。
 *
 * - **水増しした proof は容量の測定用で、検証には通らない** (ハッシュチェーンが繋がらない。capacityPadding.ts)。
 *   測定 (`packages/e2e/tests/export-capacity.bench.spec.ts`) は、できた ZIP の大きさと各段階の時間だけを読み、
 *   ZIP を正規の proof として残さない
 * - 水増しぶんは IndexedDB に書かない (保存のカーソルを差し込んだ件数まで進める)。長いセッションでは events は
 *   保存済みで、export 前の flush が書くのは差分だけなのと同じ状態にする
 * - 呼ぶ前に記録キューを排出する (排出しきれなければ throw)
 *
 * `main.ts` が `import.meta.env.DEV` のガードの中で dynamic import するので、本番ビルドには入らない
 * (production-build.spec が undefined であることを見張る)。
 */

import type { TabManager } from '../ui/tabs/TabManager.js';
import { buildCapacityPadding } from './capacityPadding.js';

export interface CapacityPadRequest {
  targetEvents: number;
  /** contentSnapshot の全文を末尾で何文字にするか (capacityPadding.ts)。省略時は元のまま */
  finalSnapshotChars?: number;
}

export interface CapacityPadResult {
  /** 水増しする前の件数 (実際の打鍵で記録した分) */
  baseEvents: number;
  /** 複製した本体の先頭の位置 (最初の keyDown) */
  bodyStart: number;
  events: number;
  checkpoints: number;
}

/** `timeExportProof` が記録する 1 回分 (exportProof の呼び出しから解決まで) */
export interface CapacityConstructTiming {
  ms: number;
  error?: string;
}

export interface TestCapacityHook {
  /** アクティブなタブのイベント列を水増しする (#628。検証には通らない) */
  pad(request: CapacityPadRequest): Promise<CapacityPadResult>;
  /**
   * アクティブなタブの `typingProof.exportProof` (proof の構築) にかかった時間を `constructTimings` に積むようにする。
   * 測るだけで、引数も戻り値も変えない
   */
  timeExportProof(): void;
  constructTimings: CapacityConstructTiming[];
}

declare global {
  interface Window {
    /** E2E 専用 (dev ビルドのみ)。export の容量の測定 (#628)。本番ビルドでは undefined */
    __tcTestCapacity?: TestCapacityHook;
  }
}

export function installCapacityHook(getTabManager: () => TabManager | null): void {
  const constructTimings: CapacityConstructTiming[] = [];
  const timeExportProof = (): void => {
    const proof = getTabManager()?.getActiveTab()?.typingProof;
    if (!proof) throw new Error('No active tab');
    const original = proof.exportProof.bind(proof);
    proof.exportProof = async (finalContent: string) => {
      const t0 = performance.now();
      try {
        const out = await original(finalContent);
        constructTimings.push({ ms: performance.now() - t0 });
        return out;
      } catch (e) {
        constructTimings.push({ ms: performance.now() - t0, error: String(e) });
        throw e;
      }
    };
  };
  const pad = async ({ targetEvents, finalSnapshotChars }: CapacityPadRequest): Promise<CapacityPadResult> => {
    const tabManager = getTabManager();
    const tab = tabManager?.getActiveTab();
    if (!tabManager || !tab) throw new Error('No active tab');
    const proof = tab.typingProof;
    const drained = await proof.waitForQueueDrain();
    if (!drained.drained) throw new Error(`event queue did not drain (${drained.remaining} remaining)`);

    const baseEvents = proof.events.length;
    const firstKeyDown = proof.events.findIndex((e) => e.type === 'keyDown');
    const bodyStart = Math.max(firstKeyDown, 0);
    const padded = buildCapacityPadding(proof.events, proof.checkpoints, {
      targetEvents,
      bodyStart,
      ...(finalSnapshotChars !== undefined ? { finalSnapshotChars } : {}),
    });
    proof.events = padded.events;
    proof.checkpoints = padded.checkpoints;
    // 水増しぶんを IndexedDB に書かせない (上の doc)。private なので測定用に限って直接触る
    (tabManager as unknown as { savedEventCursor: Map<string, number> }).savedEventCursor.set(
      tab.id,
      padded.events.length
    );
    return { baseEvents, bodyStart, events: padded.events.length, checkpoints: padded.checkpoints.length };
  };
  window.__tcTestCapacity = { pad, timeExportProof, constructTimings };
}
