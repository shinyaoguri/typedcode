/**
 * PoswManager - Proof of Sequential Work 管理
 * PoSW計算、Worker通信を担当
 */

import type { PoSWData } from '../types.js';
import { POSW_ITERATIONS as REQUIRED_POSW_ITERATIONS } from '../version.js';
import type { HashChainManager } from './HashChainManager.js';

/** `error` イベントに message が無いとき (スクリプトの読み込み失敗は ErrorEvent ではなく Event) の理由 */
const WORKER_FAILED_TO_START = 'Worker failed to start';

/** observePoswWorkerFailure が生成直後から見ていて、`error` を出した PoSW Worker (#701) */
const failedPoswWorkers = new WeakSet<Worker>();

/**
 * PoSW Worker の故障の観測を始める (#701)。**`new Worker(...)` と同じ同期区間で呼ぶこと** (間に await を挟まない)。
 *
 * スクリプトの読み込みに失敗した Worker は、生成の直後に 1 度だけ `error` を出す。呼び出し側は Worker を作ってから
 * Turnstile などを待って `PoswManager.initWorker` に渡すので、attach の時点で付ける `onerror` ではその `error` を
 * 取り逃がし、以後の要求がそれぞれ期限 (30 秒) を待つ。ここでは記録するだけで、後始末 (terminate・フォールバックへの
 * 切り替え) は `PoswManager` が attach の時点 (それより前の故障) と `onerror` (それより後の故障) で行う。
 *
 * @returns 渡した Worker (生成式をそのまま包めるように)
 */
export function observePoswWorkerFailure(worker: Worker): Worker {
  worker.addEventListener('error', () => {
    failedPoswWorkers.add(worker);
  });
  return worker;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class PoswManager {
  // PoSW設定（固定値 - セキュリティ上の理由で動的変更は不可）
  private static readonly POSW_ITERATIONS = REQUIRED_POSW_ITERATIONS;

  // ワーカーリクエストのタイムアウト（30秒）
  private static readonly WORKER_REQUEST_TIMEOUT_MS = 30000;

  private worker: Worker | null = null;
  // Worker 自体が故障した (onerror) か。立っていたら Worker を作り直さない (#701)
  private workerFailed = false;
  private requestIdCounter: number = 0;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private hashChainManager: HashChainManager;

  constructor(hashChainManager: HashChainManager) {
    this.hashChainManager = hashChainManager;
  }

  /**
   * Web Workerを初期化
   * @param externalWorker - 外部から提供されたWorker（symlinkedパッケージ対応）
   */
  initWorker(externalWorker?: Worker): void {
    if (this.worker || this.workerFailed) return;

    if (externalWorker) {
      this.worker = externalWorker;
    } else {
      this.worker = new Worker(new URL('../poswWorker.ts', import.meta.url), { type: 'module' });
    }

    // attach より前に故障していた (observePoswWorkerFailure が見た) 個体は使わない (#701)
    if (failedPoswWorkers.has(this.worker)) {
      console.warn('[PoswManager] PoSW worker failed before it was attached; using main-thread compute');
      this.discardFailedWorker(this.worker, WORKER_FAILED_TO_START);
      return;
    }

    this.worker.onmessage = (event) => {
      const response = event.data;
      const requestId = response.requestId;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.resolve(response);
      }
    };

    const worker = this.worker;
    this.worker.onerror = (error) => {
      console.error('[PoswManager] Worker error:', error);
      console.error('[PoswManager] Worker error details:', {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
      });
      this.discardFailedWorker(worker, error.message || WORKER_FAILED_TO_START);
    };
  }

  /**
   * Worker 自体の故障 (onerror、または attach より前の故障) を受けた個体を捨てる (#701)。
   *
   * 起動に失敗した Worker (配信物の欠落・CSP など) は二度と応答しない。持ち続けると後続の要求が
   * それぞれ WORKER_REQUEST_TIMEOUT_MS を待ってからフォールバックし、記録の直列化で待ちが件数に比例する。
   * pending はそれぞれ 1 度だけ reject し (ラッパーが期限のタイマーを解除する)、個体を terminate して
   * 参照を捨てる。以後の computePoSW は this.worker が無いのでメインスレッド計算へ直行する。
   * 作り直しはしない (原因はたいてい配信物・CSP で、作り直しても同じになる)。
   */
  private discardFailedWorker(worker: Worker, message: string): void {
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error(`Worker error: ${message}`));
    }
    this.pendingRequests.clear();
    // dispose 済み (#342) なら this.worker は別物か null。二重に terminate しない
    if (this.worker !== worker) return;
    this.workerFailed = true;
    this.worker = null;
    worker.terminate();
  }

  /**
   * Workerが初期化されているか確認
   */
  isWorkerInitialized(): boolean {
    return this.worker !== null;
  }

  /**
   * Workerにリクエストを送信して結果を待つ
   * @throws タイムアウトまたはワーカーエラー時にエラー
   */
  private sendWorkerRequest<T>(request: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const requestId = ++this.requestIdCounter;

      // タイムアウト設定
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Worker request timeout (id: ${requestId})`));
      }, PoswManager.WORKER_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.worker.postMessage({ ...request, requestId });
    });
  }

  /**
   * Proof of Sequential Work を計算（Worker使用、フォールバックあり）。
   *
   * Worker が落ちている / タイムアウトしても **throw せずメインスレッドで計算する**。
   * これがないと、Worker 一時障害 (タブ非アクティブ時のスロットリング、OOM 等) で
   * computePoSW が throw → TypingProof.recordEvent の catch がイベントを push せずに脱落させ、
   * チェーンは gapless のまま content replay (検証 Layer 4) が最終内容と一致せず、正規の答案でも
   * proof 全体が無効になる。メインスレッド計算は遅い (UI が一時的にもたつく) が、脱落より遥かに良い。
   */
  async computePoSW(previousHash: string, eventDataString: string): Promise<PoSWData> {
    if (this.worker) {
      try {
        const response = await this.sendWorkerRequest<{
          type: string;
          requestId: number;
          iterations: number;
          nonce: string;
          intermediateHash: string;
          computeTimeMs: number;
        }>({
          type: 'compute-posw',
          previousHash,
          eventDataString,
          iterations: PoswManager.POSW_ITERATIONS,
        });

        return {
          iterations: response.iterations,
          nonce: response.nonce,
          intermediateHash: response.intermediateHash,
          computeTimeMs: response.computeTimeMs,
        };
      } catch (err) {
        console.warn(
          '[PoswManager] Worker compute-posw failed; falling back to main-thread compute (event is preserved):',
          err
        );
        // フォールバックへ
      }
    }

    return this.computePoSWMainThread(previousHash, eventDataString);
  }

  /**
   * メインスレッドで PoSW を計算するフォールバック (poswWorker.handleComputePoSW と同一手順)。
   * Worker 未初期化 (検証ページ等) / Worker 障害時に使う。10000 回反復ぶん main thread を
   * 専有するため通常は Worker 経路を使う。
   */
  private async computePoSWMainThread(previousHash: string, eventDataString: string): Promise<PoSWData> {
    const startTime = performance.now();
    const nonceData = new Uint8Array(16);
    crypto.getRandomValues(nonceData);
    const nonce = this.hashChainManager.arrayBufferToHex(nonceData);

    let hash = await this.hashChainManager.computeHash(previousHash + eventDataString + nonce);
    for (let i = 1; i < PoswManager.POSW_ITERATIONS; i++) {
      hash = await this.hashChainManager.computeHash(hash);
    }

    return {
      iterations: PoswManager.POSW_ITERATIONS,
      nonce,
      intermediateHash: hash,
      computeTimeMs: performance.now() - startTime,
    };
  }

  /**
   * PoSW反復回数を取得（固定値）
   */
  getPoSWIterations(): number {
    return PoswManager.POSW_ITERATIONS;
  }

  /**
   * Workerをクリーンアップ
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}
