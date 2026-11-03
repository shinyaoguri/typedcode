/**
 * VerificationQueue - 検証キュー管理
 * 複数ファイルの検証を 1 本の Worker で 1 件ずつ処理し、進捗を通知する。
 *
 * - 待ち行列はイベント数の少ない順 (同数は到着順)。重い proof の後ろで軽い proof の結果が待たされないため (#331)。
 *   処理中の 1 件は動かさない
 * - 項目ごとに `cancel` (未検証のまま止める。`onCancelled` を呼ぶ) と `remove` (ファイルを消したとき。
 *   コールバックは呼ばず per-item の状態も消す) ができる。処理中の項目は Worker を terminate して作り直す
 *   (Worker は 1 本なので他の項目を巻き込まない)
 * - パース済みの proof は完了 (result / error / cancel / remove) で手放す。再検証 (`reverifyWithManifest` /
 *   `requeue`) は呼び出し側がタブの持つ proof を渡す (タブは表示のために元から proof を持っている)
 * - Worker から遅れて届いたメッセージ (作り直す前の Worker のもの・処理中でない id のもの) は捨てる
 */

import type {
  QueueItem,
  ProofFile,
  VerificationResultData,
  VerificationMode,
  WorkerRequestMessage,
  WorkerResponseMessage,
  ProgressDetails,
} from '../types.js';
import type { ExamPackageManifest } from '@typedcode/shared';

export interface ProgressCallbackParams {
  id: string;
  progress: number;
  details: ProgressDetails;
}

export type ProgressCallback = (params: ProgressCallbackParams) => void;
export type CompleteCallback = (id: string, result: VerificationResultData) => void;
export type ErrorCallback = (id: string, error: string) => void;
export type CancelledCallback = (id: string) => void;

/** 待ち行列・処理中の 1 件。proof 本体は parsedDataMap に置く (rawData の写しは持たない)。 */
interface QueueEntry {
  id: string;
  filename: string;
  /** 並べ替えの重み = proof のイベント数。 */
  weight: number;
}

/** 並べ替えの重み。イベント数 (proof の形が壊れていれば 0 = 先に回して早く error を返す)。 */
function eventCount(proofData: ProofFile): number {
  const events = proofData?.proof?.events;
  return Array.isArray(events) ? events.length : 0;
}

export class VerificationQueue {
  private queue: QueueEntry[] = [];
  private processing: QueueEntry | null = null;
  private worker: Worker | null = null;
  private isProcessing = false;
  private mode: VerificationMode = 'full';

  private onProgressCallback: ProgressCallback | null = null;
  private onCompleteCallback: CompleteCallback | null = null;
  private onErrorCallback: ErrorCallback | null = null;
  private onCancelledCallback: CancelledCallback | null = null;

  // 待ち行列・処理中の項目のパース済みデータ (完了で手放す)
  private parsedDataMap: Map<string, ProofFile> = new Map();
  private modeMap: Map<string, VerificationMode> = new Map();
  // 試験モード (ADR-0006): grader が後から読み込んだ問題パッケージ (per item)
  private manifestMap: Map<string, ExamPackageManifest> = new Map();

  /**
   * Workerを初期化
   */
  initialize(): void {
    if (this.worker) return;

    const worker = new Worker(new URL('../workers/verificationWorker.ts', import.meta.url), { type: 'module' });

    // 作り直す前の Worker から遅れて届いたものは捨てる (cancel / remove 直後のメッセージ対策)。
    worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      if (worker !== this.worker) return;
      this.handleWorkerMessage(event.data);
    };

    worker.onerror = (error) => {
      if (worker !== this.worker) return;
      console.error('[VerificationQueue] Worker error:', error);
      if (this.processing) {
        const { id } = this.processing;
        this.finishProcessing();
        this.onErrorCallback?.(id, `Worker error: ${error.message}`);
      }
    };

    this.worker = worker;
  }

  /**
   * デフォルト検証モードを設定 (個別 enqueue で上書き可)
   */
  setMode(mode: VerificationMode): void {
    this.mode = mode;
  }

  /**
   * キューにアイテムを追加。modeOverride で個別アイテムのモードを指定可
   */
  enqueue(item: QueueItem, modeOverride?: VerificationMode): void {
    // JSONをパースして保存
    let proofData: ProofFile;
    try {
      proofData = JSON.parse(item.rawData) as ProofFile;
    } catch (error) {
      console.error('[VerificationQueue] Failed to parse JSON:', error);
      this.onErrorCallback?.(item.id, `JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.modeMap.set(item.id, modeOverride ?? this.mode);
    this.schedule(item.id, item.filename, proofData);
  }

  /**
   * 試験モード (ADR-0006): 既に読み込み済みの proof を、後から渡された問題パッケージ
   * (.tcexam) で再検証する。キューは完了した proof を手放しているので、呼び出し側 (タブ) の proof を渡す。
   */
  reverifyWithManifest(id: string, manifest: ExamPackageManifest, proofData: ProofFile): void {
    this.manifestMap.set(id, manifest);
    this.schedule(id, '', proofData);
  }

  /**
   * キャンセルした項目を並べ直す (再検証)。モードは**いまの既定**を使う (重い full をキャンセルし、
   * fast に切り替えてから再検証する、という逃げ道のため)。問題パッケージは読み込み済みなら引き続き使う。
   */
  requeue(id: string, proofData: ProofFile): void {
    this.modeMap.set(id, this.mode);
    this.schedule(id, '', proofData);
  }

  /**
   * 項目の検証をやめ、`onCancelled` を呼ぶ。待ち行列にあれば外し、処理中なら Worker を作り直して次へ進む。
   * どちらにも無い id は何もしない (false を返す)。
   */
  cancel(id: string): boolean {
    if (!this.detach(id)) return false;
    this.onCancelledCallback?.(id);
    return true;
  }

  /**
   * 項目をキューから消す (ファイルを一覧から消したとき)。外し方は `cancel` と同じで、コールバックは
   * 呼ばず、その id の per-item 状態 (モード・問題パッケージ) も消す。
   */
  remove(id: string): void {
    this.detach(id);
    this.parsedDataMap.delete(id);
    this.modeMap.delete(id);
    this.manifestMap.delete(id);
  }

  /** proof を parsedDataMap に置き、イベント数の少ない順の位置に挿入する。処理中でなければ始める。 */
  private schedule(id: string, filename: string, proofData: ProofFile): void {
    this.parsedDataMap.set(id, proofData);
    // 同じ id が待ち行列に残っていれば置き換える (同じ proof を 2 回検証しない)
    this.queue = this.queue.filter((entry) => entry.id !== id);
    const entry: QueueEntry = { id, filename, weight: eventCount(proofData) };
    const at = this.queue.findIndex((queued) => queued.weight > entry.weight);
    if (at === -1) this.queue.push(entry);
    else this.queue.splice(at, 0, entry);

    if (!this.isProcessing) {
      this.processNext();
    }
  }

  /**
   * 待ち行列・処理中から id を外す。処理中なら Worker を terminate して作り直し、次へ進む。
   * 外したものがあれば true。
   */
  private detach(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.id !== id);
    const wasWaiting = this.queue.length !== before;
    const wasProcessing = this.processing?.id === id;

    if (wasProcessing) {
      this.worker?.terminate();
      this.worker = null;
      this.initialize();
      this.finishProcessing();
    } else if (wasWaiting) {
      this.parsedDataMap.delete(id);
    }
    return wasWaiting || wasProcessing;
  }

  /** 処理中の項目を終え (proof を手放し)、次へ進む。 */
  private finishProcessing(): void {
    if (this.processing) this.release(this.processing.id);
    this.processing = null;
    this.processNext();
  }

  /** 完了した項目の proof を手放す。同じ id が並べ直されて待っていれば残す。 */
  private release(id: string): void {
    if (this.queue.some((entry) => entry.id === id)) return;
    this.parsedDataMap.delete(id);
  }

  /**
   * 次のアイテムを処理
   */
  private processNext(): void {
    const next = this.queue.shift();
    if (!next) {
      this.isProcessing = false;
      this.processing = null;
      return;
    }

    this.isProcessing = true;
    this.processing = next;

    const proofData = this.parsedDataMap.get(next.id);
    if (!proofData) {
      this.processing = null;
      this.onErrorCallback?.(next.id, 'Proof data not found');
      this.processNext();
      return;
    }

    if (!this.worker) {
      this.initialize();
    }

    const message: WorkerRequestMessage = {
      type: 'verify',
      id: next.id,
      proofData,
      mode: this.modeMap.get(next.id) ?? this.mode,
      manifest: this.manifestMap.get(next.id),
    };

    this.worker!.postMessage(message);
  }

  /**
   * Workerからのメッセージを処理
   */
  private handleWorkerMessage(msg: WorkerResponseMessage): void {
    // 処理中でない id のメッセージ (キャンセル済み・消した項目の遅延メッセージ) は捨てる
    if (msg.id !== this.processing?.id) return;

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
            });
          } catch (error) {
            console.error('[VerificationQueue] Error in onProgressCallback:', error);
          }
        }
        break;

      case 'result':
        // proof を手放して次へ進めてから (キューの状態を更新してから) コールバックを呼ぶ。
        // 結果表示に要る proof はタブ (VerifyTabState.proofData) が持っている。
        this.finishProcessing();
        if (msg.result) {
          try {
            this.onCompleteCallback?.(msg.id, msg.result);
          } catch (error) {
            console.error('[VerificationQueue] Error in onCompleteCallback:', error);
          }
        }
        break;

      case 'error':
        this.finishProcessing();
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
  getCurrentProcessing(): Pick<QueueItem, 'id' | 'filename'> | null {
    return this.processing ? { id: this.processing.id, filename: this.processing.filename } : null;
  }

  /**
   * 処理中かどうかを取得
   */
  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
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
   * キャンセルのコールバックを設定 (`cancel` で外したときに呼ぶ。`remove` では呼ばない)
   */
  setOnCancelled(callback: CancelledCallback): void {
    this.onCancelledCallback = callback;
  }

  /**
   * キューをクリア
   */
  clear(): void {
    this.queue = [];
    this.parsedDataMap.clear();
    this.modeMap.clear();
    this.manifestMap.clear();
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
    this.modeMap.clear();
    this.manifestMap.clear();
    this.processing = null;
    this.isProcessing = false;
  }
}
