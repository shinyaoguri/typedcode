/**
 * 同期状態の決め方 (#543 / #300)。
 *
 * 同期状態は「PoSW の処理が済んだか」ではなく「永続化できたか」を表す。保存の結果
 * (IndexedDB の成否・sessionStorage の成否) と PoSW 待ちのイベントの有無から状態を決める。
 * 失敗は pending より優先する (書けていないことを、処理待ちの表示で隠さない)。
 */

/**
 * 同期状態 (`#sync-status-item[data-state]` の値域。editor AGENTS.md の状態契約)
 * - `synced`: IndexedDB と sessionStorage の両方に保存でき、PoSW 待ちのイベントも無い
 * - `syncing`: 保存中
 * - `pending`: 保存待ち (デバウンス中・PoSW 待ちのイベントがある)
 * - `degraded`: 片方 (IndexedDB か sessionStorage) にだけ保存できた
 * - `failed`: どちらにも保存できなかった
 */
export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'degraded' | 'failed';

/** 1 回の永続化 (IndexedDB → sessionStorage) の結果 */
export interface PersistOutcome {
  /** IndexedDB への保存が commit まで届いた (セッション未初期化で書かなかった場合も true) */
  idbOk: boolean;
  /** sessionStorage への保存ができた (リセット確定後で書かなかった場合も true) */
  sessionStorageOk: boolean;
  /** IndexedDB への保存の失敗理由 */
  error?: unknown;
}

export interface SyncStatusInput {
  idbOk: boolean;
  sessionStorageOk: boolean;
  /** いずれかのタブに PoSW 待ちのイベントがある */
  hasPendingEvents: boolean;
}

/** 保存の結果から同期状態を決める */
export function resolveSyncStatus({ idbOk, sessionStorageOk, hasPendingEvents }: SyncStatusInput): SyncStatus {
  if (!idbOk && !sessionStorageOk) return 'failed';
  if (!idbOk || !sessionStorageOk) return 'degraded';
  return hasPendingEvents ? 'pending' : 'synced';
}

/** 保存の失敗を表す状態か (表示を次の永続化の結果まで保つ対象) */
export function isPersistFailure(status: SyncStatus): boolean {
  return status === 'degraded' || status === 'failed';
}
