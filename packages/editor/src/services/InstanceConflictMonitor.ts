/**
 * InstanceConflictMonitor - 同じセッションを 2 つのインスタンスが記録する状態を解く (#237 PR-3)
 *
 * 二重インスタンスが成立するのは、SingleInstanceGuard が Web Locks を使えず ping → pong に戻った経路だけ
 * (凍結中の既存タブは pong を返せず、後発が active になる。Web Locks の経路では、ロックを持つ既存タブがいる間
 * 後発は active にならない)。後発が復旧ダイアログでセッションを再開すると、sessions 行の instanceId が後発に
 * 書き換わる。
 *
 * **どちらが譲るか = sessions 行の instanceId が自分でない側** (`SessionStorageService.verifyOwnership`)。
 * 最後に再開した 1 インスタンスだけが owner なので、凍結を解かれて「後から復帰した側」が譲り、いま使われて
 * いる側の記録は続く。時計・乱数には依存しない。
 *
 * 所有者を確かめる契機:
 * - ガードの重複検出 (`instance-active` の受信。相手が active な間は heartbeat ごと)
 * - 凍結・非表示からの復帰 (`resume` / `visibilitychange` で visible / `pageshow`)。確認は保存の待ち行列に
 *   差し込まれるので、同じ契機で記録したイベントの書き込みより先に結果が出る
 *
 * 譲ると決まったら (`setOnOwnershipLost`) 1 回だけ `enterInstanceConflictReadOnly` に進む。
 */

import type { OwnershipCheck } from './SessionStorageService.js';

export interface InstanceConflictMonitorDeps {
  guard: { setOnDuplicateDetected(callback: ((senderId: string) => void) | null): void };
  ownership: {
    verifyOwnership(): Promise<OwnershipCheck>;
    setOnOwnershipLost(callback: (() => void) | null): void;
  };
  /** `resume` / `visibilitychange` を受ける (document) */
  documentTarget: Pick<Document, 'addEventListener' | 'removeEventListener'> & { readonly visibilityState: string };
  /** `pageshow` を受ける (window) */
  windowTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** 所有権を失ったときに 1 回だけ呼ぶ */
  onYield: () => void;
}

/**
 * 監視を始める。戻り値で止める (譲ったときは自分で止まる)。
 */
export function startInstanceConflictMonitor(deps: InstanceConflictMonitorDeps): () => void {
  const { guard, ownership, documentTarget, windowTarget, onYield } = deps;
  let stopped = false;

  const verify = (): void => {
    if (stopped) return;
    void ownership.verifyOwnership();
  };
  const onVisibilityChange = (): void => {
    if (documentTarget.visibilityState === 'visible') verify();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    guard.setOnDuplicateDetected(null);
    ownership.setOnOwnershipLost(null);
    documentTarget.removeEventListener('resume', verify);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    windowTarget.removeEventListener('pageshow', verify);
  };

  ownership.setOnOwnershipLost(() => {
    if (stopped) return;
    stop();
    onYield();
  });
  guard.setOnDuplicateDetected(verify);
  documentTarget.addEventListener('resume', verify);
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  windowTarget.addEventListener('pageshow', verify);

  return stop;
}

/** 読み取り専用にするときに止める相手。どれかが無い (null) ときは飛ばす */
export interface InstanceConflictReadOnlyTargets {
  /** 記録 (PoSW・チェーンへの追記) を止める */
  eventRecorder: { setEnabled(enabled: boolean): void } | null;
  /** 永続化 (sessionStorage / IndexedDB への保存と再試行) を止め、各タブの署名の依頼を止める */
  tabManager: {
    suspendPersistence(): void;
    getAllTabs(): ReadonlyArray<{ signedCheckpointService?: { dispose(): void } | null }>;
  } | null;
  /** スクリーンショットの撮影を止める (チェーンに載らない画像を残さない) */
  screenshotTracker: { setCaptureEnabled(enabled: boolean): void } | null;
  /** ガードの heartbeat を止める (残る側に重複を知らせ続けない) */
  guard: { dispose(): void };
  /** エディタを読み取り専用にする */
  setEditorReadOnly: () => void;
  /** 競合の画面 (救出ボタン付き) を出す */
  showConflictScreen: () => void;
}

/**
 * 所有権を失ったタブを読み取り専用にする (#237 PR-3)。
 *
 * 記録・保存・署名の依頼を止め、競合の画面を出す。**既存の記録は書き換えない** (メモリ上のチェーンと
 * 保存済みの行はそのまま。救出はメモリ上のコードと記録を読む = 不変条件 7)。保存層は所有権を失った時点で
 * 書き込みを拒否しているので、ここで止め損ねたものがあっても、もう一方の記録には届かない。
 * 1 つの停止に失敗しても残りと画面は続ける (画面が出ないのが一番困る)。
 */
export function enterInstanceConflictReadOnly(targets: InstanceConflictReadOnlyTargets): void {
  const steps: Array<[string, () => void]> = [
    ['stop recording', () => targets.eventRecorder?.setEnabled(false)],
    ['suspend persistence', () => targets.tabManager?.suspendPersistence()],
    [
      'stop signing',
      () => {
        for (const tab of targets.tabManager?.getAllTabs() ?? []) tab.signedCheckpointService?.dispose();
      },
    ],
    ['stop screenshots', () => targets.screenshotTracker?.setCaptureEnabled(false)],
    ['stop heartbeat', () => targets.guard.dispose()],
    ['make editor read-only', targets.setEditorReadOnly],
    ['show conflict screen', targets.showConflictScreen],
  ];
  for (const [label, step] of steps) {
    try {
      step();
    } catch (e) {
      console.error(`[InstanceConflict] Failed to ${label}:`, e);
    }
  }
}
