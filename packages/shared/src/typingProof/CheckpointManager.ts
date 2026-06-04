/**
 * CheckpointManager - チェックポイント管理
 * チェックポイントの作成と管理を担当
 */

import type { CheckpointData, SignedCheckpointEnvelope, StoredEvent } from '../types.js';
import { HashChainManager } from './HashChainManager.js';

export type CheckpointCreatedHook = (checkpoint: CheckpointData) => void | Promise<void>;

/** Default N: number of events that triggers a checkpoint */
export const DEFAULT_MAX_EVENTS_PER_CHECKPOINT = 100;

/** Default T (ms): max elapsed time before a checkpoint */
export const DEFAULT_MAX_CHECKPOINT_INTERVAL_MS = 10_000;

export interface CheckpointManagerOptions {
  /** N: number of events that triggers a checkpoint */
  maxEventsPerCheckpoint?: number;
  /** T (ms): max elapsed time before a checkpoint */
  maxIntervalMs?: number;
  /** clock source (overridable for tests) */
  now?: () => number;
}

export class CheckpointManager {
  /**
   * @deprecated Kept for backward compatibility with consumers that
   * referenced the static value. The runtime behaviour is now driven by
   * the hybrid (events + elapsed time) trigger in shouldCreateCheckpoint.
   * Use DEFAULT_MAX_EVENTS_PER_CHECKPOINT instead.
   */
  static readonly CHECKPOINT_INTERVAL = DEFAULT_MAX_EVENTS_PER_CHECKPOINT;

  private checkpoints: CheckpointData[] = [];
  private hashChainManager: HashChainManager;
  private onCheckpointCreated: CheckpointCreatedHook | null = null;

  private readonly maxEventsPerCheckpoint: number;
  private readonly maxIntervalMs: number;
  private readonly now: () => number;
  private lastCheckpointEventIndex = -1;
  private lastCheckpointAt: number | null = null;

  constructor(
    hashChainManager: HashChainManager,
    options: CheckpointManagerOptions = {}
  ) {
    this.hashChainManager = hashChainManager;
    this.maxEventsPerCheckpoint =
      options.maxEventsPerCheckpoint ?? DEFAULT_MAX_EVENTS_PER_CHECKPOINT;
    this.maxIntervalMs =
      options.maxIntervalMs ?? DEFAULT_MAX_CHECKPOINT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 新しいチェックポイント作成直後に呼ばれるフックを登録。
   * 失敗時 (signing API 例外など) は呼び出し側でハンドルする。
   * 引数: 直前に push された CheckpointData (まだ未署名)。
   */
  setOnCheckpointCreated(hook: CheckpointCreatedHook | null): void {
    this.onCheckpointCreated = hook;
  }

  /**
   * 既存 checkpoint (event のインデックス一致) に signature を反映。
   * 非同期で署名が返ってきたタイミングで SignedCheckpointService から呼ばれる。
   * 該当 checkpoint が存在しなければ silent no-op。
   */
  updateSignature(eventIndex: number, envelope: SignedCheckpointEnvelope): boolean {
    const checkpoint = this.checkpoints.find((cp) => cp.eventIndex === eventIndex);
    if (!checkpoint) return false;
    checkpoint.signature = envelope;
    return true;
  }

  /**
   * チェックポイントを取得
   */
  getCheckpoints(): CheckpointData[] {
    return this.checkpoints;
  }

  /**
   * チェックポイントを設定 (復元用)。
   * トリガ状態 (最終 cp の eventIndex / 時刻) も再構築する。
   */
  setCheckpoints(checkpoints: CheckpointData[]): void {
    this.checkpoints = checkpoints;
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last) {
      this.lastCheckpointEventIndex = last.eventIndex;
      // 復元時の元 wall-clock は不明。`now()` を使い、リストア直後すぐ
      // 時間トリガが発火しないようにする (T ms 経過後に発火)。
      this.lastCheckpointAt = this.now();
    } else {
      this.lastCheckpointEventIndex = -1;
      this.lastCheckpointAt = null;
    }
  }

  /**
   * チェックポイントを追加
   */
  addCheckpoint(checkpoint: CheckpointData): void {
    this.checkpoints.push(checkpoint);
  }

  /**
   * チェックポイントをクリア
   */
  clearCheckpoints(): void {
    this.checkpoints = [];
    this.lastCheckpointEventIndex = -1;
    this.lastCheckpointAt = null;
  }

  /**
   * チェックポイントを作成
   * @param eventIndex - チェックポイントを作成するイベントインデックス
   * @param events - イベント配列
   */
  async createCheckpoint(eventIndex: number, events: StoredEvent[]): Promise<void> {
    const event = events[eventIndex];
    if (!event) return;

    // イベントのデータからコンテンツハッシュを計算
    const contentHash = event.data
      ? await this.hashChainManager.computeHash(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
      : '';

    const checkpoint: CheckpointData = {
      eventIndex,
      hash: event.hash,
      timestamp: event.timestamp,
      contentHash
    };

    this.checkpoints.push(checkpoint);
    this.lastCheckpointEventIndex = eventIndex;
    this.lastCheckpointAt = this.now();
    console.log(`[CheckpointManager] Checkpoint created at event ${eventIndex}, hash: ${event.hash.substring(0, 16)}...`);

    // hook を発火。失敗してもチェーンを止めない。
    if (this.onCheckpointCreated) {
      try {
        const result = this.onCheckpointCreated(checkpoint);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            console.warn('[CheckpointManager] onCheckpointCreated hook rejected:', err);
          });
        }
      } catch (err) {
        console.warn('[CheckpointManager] onCheckpointCreated hook threw:', err);
      }
    }
  }

  /**
   * イベントインデックスに基づいてチェックポイントを自動作成するか判定。
   * ハイブリッドトリガ: 最終 cp から N イベント以上経過、または
   * 最終 cp から T ms 以上経過のいずれかで true。
   * 時間トリガは最初の cp 作成後にのみ評価する。
   */
  shouldCreateCheckpoint(eventIndex: number): boolean {
    const eventsSinceLast =
      this.lastCheckpointEventIndex < 0
        ? eventIndex + 1
        : eventIndex - this.lastCheckpointEventIndex;
    if (eventsSinceLast >= this.maxEventsPerCheckpoint) return true;
    if (this.lastCheckpointAt !== null) {
      const elapsed = Math.max(0, this.now() - this.lastCheckpointAt);
      if (elapsed >= this.maxIntervalMs) return true;
    }
    return false;
  }

  /**
   * エクスポート用にチェックポイントをクリーンアップ。
   * 同一 eventIndex の重複を除去 (最後の登録を採用) し、昇順に整える。
   * 動的トリガ下ではフィルタ条件 (旧 modulo) は意味を成さないため、
   * 防御的な dedupe のみを行う。
   */
  cleanupForExport(): void {
    const byIndex = new Map<number, CheckpointData>();
    for (const cp of this.checkpoints) byIndex.set(cp.eventIndex, cp);
    this.checkpoints = [...byIndex.values()].sort((a, b) => a.eventIndex - b.eventIndex);
  }

  /**
   * 最後のチェックポイントを取得
   */
  getLastCheckpoint(): CheckpointData | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }
}
