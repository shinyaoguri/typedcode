/**
 * PoswManager - Proof of Sequential Work 管理
 * PoSW計算/検証、Worker通信を担当
 */

import type { PoSWData } from '../types.js';
import { POSW_ITERATIONS as REQUIRED_POSW_ITERATIONS } from '../version.js';
import { HashChainManager } from './HashChainManager.js';

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
    if (this.worker) return;

    if (externalWorker) {
      this.worker = externalWorker;
    } else {
      this.worker = new Worker(
        new URL('../poswWorker.ts', import.meta.url),
        { type: 'module' }
      );
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

    this.worker.onerror = (error) => {
      console.error('[PoswManager] Worker error:', error);
      console.error('[PoswManager] Worker error details:', {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
      });
      // すべてのpending requestsをreject
      for (const [, { reject }] of this.pendingRequests) {
        reject(new Error(`Worker error: ${error.message}`));
      }
      this.pendingRequests.clear();
    };
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
        }
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
   * verifyPoSW のフォールバックと対称。
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
          iterations: PoswManager.POSW_ITERATIONS
        });

        return {
          iterations: response.iterations,
          nonce: response.nonce,
          intermediateHash: response.intermediateHash,
          computeTimeMs: response.computeTimeMs
        };
      } catch (err) {
        console.warn('[PoswManager] Worker compute-posw failed; falling back to main-thread compute (event is preserved):', err);
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
   * PoSWを検証（Worker使用、フォールバックあり）
   */
  async verifyPoSW(previousHash: string, eventDataString: string, posw: PoSWData): Promise<boolean> {
    if (posw.iterations !== PoswManager.POSW_ITERATIONS) {
      return false;
    }

    // Workerが初期化されている場合はWorkerを使用
    if (this.worker) {
      const response = await this.sendWorkerRequest<{
        type: string;
        requestId: number;
        valid: boolean;
      }>({
        type: 'verify-posw',
        previousHash,
        eventDataString,
        nonce: posw.nonce,
        iterations: posw.iterations,
        expectedHash: posw.intermediateHash
      });

      return response.valid;
    }

    // フォールバック: メインスレッドで検証（検証ページ用）
    let hash = await this.hashChainManager.computeHash(previousHash + eventDataString + posw.nonce);

    for (let i = 1; i < posw.iterations; i++) {
      hash = await this.hashChainManager.computeHash(hash);
    }

    return hash === posw.intermediateHash;
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
