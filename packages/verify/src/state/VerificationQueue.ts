/**
 * VerificationQueue - 検証キュー管理
 * 複数ファイルの検証を順番に処理し、進捗を通知する
 */

import type {
  QueueItem,
  ProofFile,
  VerificationResultData,
  WorkerRequestMessage,
  WorkerResponseMessage,
  ProgressDetails,
} from '../types.js';

export interface ProgressCallbackParams {
  id: string;
  progress: number;
  details: ProgressDetails;
  hashInfo?: { computed: string; expected: string; poswHash?: string };
}

export type ProgressCallback = (params: ProgressCallbackParams) => void;
export type CompleteCallback = (id: string, result: VerificationResultData) => void;
export type ErrorCallback = (id: string, error: string) => void;

export class VerificationQueue {
  private queue: QueueItem[] = [];
  private processing: QueueItem | null = null;
  private worker: Worker | null = null;
  private isProcessing = false;

  private onProgressCallback: ProgressCallback | null = null;
  private onCompleteCallback: CompleteCallback | null = null;
  private onErrorCallback: ErrorCallback | null = null;

  // 各アイテムのパース済みデータを保持
  private parsedDataMap: Map<string, ProofFile> = new Map();

  /**
   * Workerを初期化
   */
  initialize(): void {
    if (this.worker) return;

    this.worker = new Worker(
      new URL('../workers/verificationWorker.ts', import.meta.url),
      { type: 'module' }
    );

    this.worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      this.handleWorkerMessage(event.data);
    };

    this.worker.onerror = (error) => {
      console.error('[VerificationQueue] Worker error:', error);
      if (this.processing) {
        this.onErrorCallback?.(this.processing.id, `Worker error: ${error.message}`);
        this.processNext();
      }
    };
  }

  /**
   * キューにアイテムを追加
   */
  enqueue(item: QueueItem): void {
    // JSONをパースして保存
    try {
      const proofData = JSON.parse(item.rawData) as ProofFile;
      this.parsedDataMap.set(item.id, proofData);
      this.queue.push(item);

      // 処理中でなければ開始
      if (!this.isProcessing) {
        this.processNext();
      }
    } catch (error) {
      console.error('[VerificationQueue] Failed to parse JSON:', error);
      this.onErrorCallback?.(item.id, `JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 次のアイテムを処理
   */
  private processNext(): void {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      this.processing = null;
      return;
    }

    this.isProcessing = true;
    this.processing = this.queue.shift()!;

    const proofData = this.parsedDataMap.get(this.processing.id);
    if (!proofData) {
      this.onErrorCallback?.(this.processing.id, 'Proof data not found');
      this.processNext();
      return;
    }

    if (!this.worker) {
      this.initialize();
    }

    const message: WorkerRequestMessage = {
      type: 'verify',
      id: this.processing.id,
      proofData,
    };

    this.worker!.postMessage(message);
  }

  /**
   * Workerからのメッセージを処理
   */
  private handleWorkerMessage(msg: WorkerResponseMessage): void {
    switch (msg.type) {
      case 'progress':
        if (msg.current !== undefined && msg.total !== undefined && msg.phase) {
          const progress = Math.round((msg.current / msg.total) * 100);
          const details: ProgressDetails = {
            phase: msg.phase,
            current: msg.current,
            total: msg.total,
            totalEvents: msg.totalEvents,
          };
          try {
            this.onProgressCallback?.({
              id: msg.id,
              progress,
              details,
              hashInfo: msg.hashInfo,
            });
          } catch (error) {
            console.error('[VerificationQueue] Error in onProgressCallback:', error);
          }
        }
        break;

      case 'result':
        // 処理済みデータをクリーンアップ（メモリ節約）
        // ただしproofDataは結果表示に必要なので残す
        // processNextを先に呼ぶことでキューの状態を更新してからコールバックを呼ぶ
        this.processNext();
        if (msg.result) {
          try {
            this.onCompleteCallback?.(msg.id, msg.result);
          } catch (error) {
            console.error('[VerificationQueue] Error in onCompleteCallback:', error);
          }
        }
        break;

      case 'error':
        this.processNext();
        this.onErrorCallback?.(msg.id, msg.error ?? 'Unknown error');
        break;
    }
  }

  /**
   * キューの長さを取得（処理中のアイテムは含まない）
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * 現在処理中のアイテムを取得
   */
  getCurrentProcessing(): QueueItem | null {
    return this.processing;
  }

  /**
   * 処理中かどうかを取得
   */
  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * パース済みのProofDataを取得
   */
  getParsedData(id: string): ProofFile | null {
    return this.parsedDataMap.get(id) ?? null;
  }

  /**
   * 進捗コールバックを設定
   */
  setOnProgress(callback: ProgressCallback): void {
    this.onProgressCallback = callback;
  }

  /**
   * 完了コールバックを設定
   */
  setOnComplete(callback: CompleteCallback): void {
    this.onCompleteCallback = callback;
  }

  /**
   * エラーコールバックを設定
   */
  setOnError(callback: ErrorCallback): void {
    this.onErrorCallback = callback;
  }

  /**
   * キューをクリア
   */
  clear(): void {
    this.queue = [];
    this.parsedDataMap.clear();
    // 処理中のアイテムはそのまま完了を待つ
  }

  /**
   * Workerを終了
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.queue = [];
    this.parsedDataMap.clear();
    this.processing = null;
    this.isProcessing = false;
  }
}
