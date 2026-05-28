/**
 * CheckpointManager - チェックポイント管理
 * チェックポイントの作成と管理を担当
 */

import type { CheckpointData, SignedCheckpointEnvelope, StoredEvent } from '../types.js';
import { HashChainManager } from './HashChainManager.js';

export type CheckpointCreatedHook = (checkpoint: CheckpointData) => void | Promise<void>;

export class CheckpointManager {
  // チェックポイント間隔
  static readonly CHECKPOINT_INTERVAL = 33;

  private checkpoints: CheckpointData[] = [];
  private hashChainManager: HashChainManager;
  private onCheckpointCreated: CheckpointCreatedHook | null = null;

  constructor(hashChainManager: HashChainManager) {
    this.hashChainManager = hashChainManager;
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
   * チェックポイントを設定
   */
  setCheckpoints(checkpoints: CheckpointData[]): void {
    this.checkpoints = checkpoints;
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
   * イベントインデックスに基づいてチェックポイントを自動作成するか判定
   */
  shouldCreateCheckpoint(eventIndex: number): boolean {
    return (eventIndex + 1) % CheckpointManager.CHECKPOINT_INTERVAL === 0;
  }

  /**
   * エクスポート用にチェックポイントをクリーンアップ
   * 正規のチェックポイント（CHECKPOINT_INTERVALの倍数-1）以外を削除
   */
  cleanupForExport(): void {
    this.checkpoints = this.checkpoints.filter(cp => {
      return (cp.eventIndex + 1) % CheckpointManager.CHECKPOINT_INTERVAL === 0;
    });
  }

  /**
   * 最後のチェックポイントを取得
   */
  getLastCheckpoint(): CheckpointData | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }
}
