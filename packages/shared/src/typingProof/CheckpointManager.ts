/**
 * CheckpointManager - チェックポイント管理
 * チェックポイントの作成と管理を担当
 */

import type { CheckpointData, StoredEvent } from '../types.js';
import { HashChainManager } from './HashChainManager.js';

export class CheckpointManager {
  // チェックポイント間隔
  static readonly CHECKPOINT_INTERVAL = 33;

  private checkpoints: CheckpointData[] = [];
  private hashChainManager: HashChainManager;

  constructor(hashChainManager: HashChainManager) {
    this.hashChainManager = hashChainManager;
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
