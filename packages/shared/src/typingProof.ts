/**
 * TypingProof - タイピング証明システム
 * コピペを禁止し、全ての操作をハッシュ鎖として記録
 */

import type {
  RecordEventInput,
  RecordEventResult,
  EventHashData,
  StoredEvent,
  VerificationResult,
  TypingProofVerificationResult,
  SignatureData,
  ExportedProof,
  TypingStats,
  TypingStatistics,
  TypingProofHashResult,
  ProofData,
  FingerprintComponents,
  InputType,
  EventType,
  PoSWData,
  SerializedProofState,
  CheckpointData,
  SampledSegmentInfo,
  HumanAttestationEventData,
} from './types.js';

export class TypingProof {
  events: StoredEvent[] = [];
  currentHash: string | null = null;
  fingerprint: string | null = null;
  fingerprintComponents: FingerprintComponents | null = null;
  startTime: number = performance.now();
  initialized: boolean = false;
  private recordQueue: Promise<RecordEventResult> = Promise.resolve({ hash: '', index: -1 });

  // チェックポイント関連
  checkpoints: CheckpointData[] = [];
  private static readonly CHECKPOINT_INTERVAL = 100;  // 100イベントごとにチェックポイント作成

  // PoSW設定（固定値 - セキュリティ上の理由で動的変更は不可）
  private static readonly POSW_ITERATIONS = 10000;

  // Web Worker関連
  private worker: Worker | null = null;
  private requestIdCounter: number = 0;
  private pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = new Map();

  // キュー待ち数（recordQueueに積まれているイベント数）
  private queuedEventCount: number = 0;

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
        new URL('./poswWorker.ts', import.meta.url),
        { type: 'module' }
      );
    }

    this.worker.onmessage = (event) => {
      const response = event.data;

      // PoSW計算・検証結果
      const requestId = response.requestId;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.resolve(response);
      }
    };

    this.worker.onerror = (error) => {
      console.error('[TypingProof] Worker error:', error);
      console.error('[TypingProof] Worker error details:', {
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

  // ワーカーリクエストのタイムアウト（30秒）
  private static readonly WORKER_REQUEST_TIMEOUT_MS = 30000;

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
      }, TypingProof.WORKER_REQUEST_TIMEOUT_MS);

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
   * 初期化（非同期）
   * フィンガープリントを生成して初期ハッシュを設定
   * @param fingerprintHash - フィンガープリントハッシュ
   * @param fingerprintComponents - フィンガープリントコンポーネント
   * @param externalWorker - 外部から提供されたWorker（symlinkedパッケージ対応）
   */
  async initialize(
    fingerprintHash: string,
    fingerprintComponents: FingerprintComponents,
    externalWorker?: Worker
  ): Promise<void> {
    this.fingerprint = fingerprintHash;
    this.fingerprintComponents = fingerprintComponents;
    this.currentHash = await this.initialHash(fingerprintHash);

    // Web Workerを初期化
    this.initWorker(externalWorker);

    console.log('[TypingProof] Initialized with fixed PoSW iterations:', TypingProof.POSW_ITERATIONS);

    this.initialized = true;
  }

  /**
   * 人間認証をevent #0として記録
   * reCAPTCHA attestationをハッシュチェーンの最初のイベントとして記録し、
   * 「人間がファイルを作り始めた」ことを証明する
   * @param attestation - reCAPTCHA認証結果
   * @throws 既にイベントが存在する場合はエラー
   */
  async recordHumanAttestation(attestation: HumanAttestationEventData): Promise<RecordEventResult> {
    if (this.events.length > 0) {
      throw new Error('Human attestation must be event #0 (no events should exist yet)');
    }

    return await this.recordEvent({
      type: 'humanAttestation',
      data: attestation,
      description: `Human verified (score: ${attestation.score.toFixed(2)}, action: ${attestation.action})`,
    });
  }

  /**
   * 人間認証イベントを持っているかチェック
   */
  hasHumanAttestation(): boolean {
    return this.events.length > 0 && this.events[0]?.type === 'humanAttestation';
  }

  /**
   * 人間認証イベントを取得
   */
  getHumanAttestation(): HumanAttestationEventData | null {
    if (!this.hasHumanAttestation()) return null;
    return this.events[0]?.data as HumanAttestationEventData;
  }

  /**
   * エクスポート前の人間認証を記録
   * ファイル作成時（event #0）とは別に、エクスポート直前の認証を記録する
   * @param attestation - Turnstile認証結果
   */
  async recordPreExportAttestation(attestation: HumanAttestationEventData): Promise<RecordEventResult> {
    return await this.recordEvent({
      type: 'preExportAttestation',
      data: attestation,
      description: `Pre-export verification (score: ${attestation.score.toFixed(2)}, action: ${attestation.action})`,
    });
  }

  /**
   * 初期ハッシュを生成（フィンガープリント + ランダム値）
   */
  async initialHash(fingerprintHash: string): Promise<string> {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const randomHex = this.arrayBufferToHex(randomData);

    // フィンガープリント + ランダム値をハッシュ化
    const combined = fingerprintHash + randomHex;
    return await this.computeHash(combined);
  }

  /**
   * オブジェクトをキーがソートされた決定的なJSON文字列に変換
   * ハッシュ計算時の一貫性を保証するため、キー順序を常にソート
   */
  private deterministicStringify(obj: unknown): string {
    return JSON.stringify(obj, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, unknown>).sort().reduce((sorted, k) => {
          sorted[k] = (value as Record<string, unknown>)[k];
          return sorted;
        }, {} as Record<string, unknown>);
      }
      return value;
    });
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
    const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return Array.from(uint8Array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return this.arrayBufferToHex(hashBuffer);
  }

  /**
   * Proof of Sequential Work を計算（Worker使用）
   */
  async computePoSW(previousHash: string, eventDataString: string): Promise<PoSWData> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

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
      iterations: TypingProof.POSW_ITERATIONS
    });

    return {
      iterations: response.iterations,
      nonce: response.nonce,
      intermediateHash: response.intermediateHash,
      computeTimeMs: response.computeTimeMs
    };
  }

  /**
   * PoSWを検証（Worker使用、フォールバックあり）
   */
  async verifyPoSW(previousHash: string, eventDataString: string, posw: PoSWData): Promise<boolean> {
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
    let hash = await this.computeHash(previousHash + eventDataString + posw.nonce);

    for (let i = 1; i < posw.iterations; i++) {
      hash = await this.computeHash(hash);
    }

    return hash === posw.intermediateHash;
  }

  /**
   * PoSW反復回数を取得（固定値）
   */
  getPoSWIterations(): number {
    return TypingProof.POSW_ITERATIONS;
  }

  /**
   * イベントを記録してハッシュ鎖を更新（排他制御付き）
   * エラーが発生しても可能な限りチェーンを継続し、部分的な検証を可能にする
   * @returns ハッシュと配列のインデックス
   * @throws 初期化前に呼び出された場合はエラー
   */
  async recordEvent(event: RecordEventInput): Promise<RecordEventResult> {
    // 初期化チェック
    if (!this.initialized) {
      throw new Error('TypingProof not initialized. Call initialize() first.');
    }

    // キュー待ち数を増加
    this.queuedEventCount++;

    // 前のイベント記録が完了するまで待つ（排他制御）
    // エラーが発生してもチェーンを継続させる
    this.recordQueue = this.recordQueue
      .catch(() => {
        // 前のイベントでエラーが発生してもチェーンを継続
      })
      .then(async () => {
        try {
          return await this._recordEventInternal(event);
        } catch (error) {
          // エラー発生時もログを出力するがチェーンは継続
          console.error('[TypingProof] Event recording error (chain continues):', error);
          // エラー時は現在の状態を返す（チェーンは途切れない）
          return { hash: this.currentHash ?? '', index: this.events.length - 1 };
        } finally {
          // 処理完了後にキュー待ち数を減少
          this.queuedEventCount--;
        }
      });
    return this.recordQueue;
  }

  /**
   * イベントを記録する内部実装
   * @private
   */
  private async _recordEventInternal(event: RecordEventInput): Promise<RecordEventResult> {
    const timestamp = performance.now() - this.startTime;
    const sequence = this.events.length;

    // PoSW計算前のイベントデータ（poswフィールドなし）
    const eventDataWithoutPoSW = {
      sequence,
      timestamp,
      type: event.type,
      inputType: event.inputType ?? null,
      data: event.data ?? null,
      rangeOffset: event.rangeOffset ?? null,
      rangeLength: event.rangeLength ?? null,
      range: event.range ?? null,
      previousHash: this.currentHash
    };

    // PoSW計算（前のハッシュに依存 → 逐次計算を強制）
    // 決定的なJSON文字列化を使用（キー順序を保証）
    const eventDataString = this.deterministicStringify(eventDataWithoutPoSW);
    const posw = await this.computePoSW(this.currentHash ?? '', eventDataString);

    // ハッシュ計算に使用するフィールド（PoSW含む）
    const eventData: EventHashData = {
      ...eventDataWithoutPoSW,
      posw
    };

    // イベントデータを決定的に文字列化してハッシュ計算
    const eventString = this.deterministicStringify(eventData);
    const combinedData = this.currentHash + eventString;
    this.currentHash = await this.computeHash(combinedData);

    // デバッグ: ハッシュ計算に使用したデータをログ出力
    if (this.events.length < 10) {
      console.log(`[Record] Event ${this.events.length}:`, {
        type: event.type,
        sequence,
        timestamp: timestamp.toFixed(2),
        poswIterations: posw.iterations,
        poswTimeMs: posw.computeTimeMs.toFixed(2),
        hash: this.currentHash
      });
    }

    // イベントを保存（ハッシュ計算に使用したフィールド + 追加のメタデータ）
    const eventIndex = this.events.length;
    const storedEvent: StoredEvent = {
      ...eventData,
      hash: this.currentHash,
      description: event.description ?? null,
      isMultiLine: event.isMultiLine ?? null,
      deletedLength: event.deletedLength ?? null,
      insertedText: event.insertedText ?? null,
      insertLength: event.insertLength ?? null,
      deleteDirection: event.deleteDirection ?? null,
      selectedText: event.selectedText ?? null
    };
    this.events.push(storedEvent);

    // チェックポイントの自動作成（CHECKPOINT_INTERVALイベントごと）
    if ((eventIndex + 1) % TypingProof.CHECKPOINT_INTERVAL === 0) {
      await this.createCheckpoint(eventIndex);
    }

    return { hash: this.currentHash, index: eventIndex };
  }

  /**
   * チェックポイントを作成
   * @param eventIndex - チェックポイントを作成するイベントインデックス
   */
  private async createCheckpoint(eventIndex: number): Promise<void> {
    const event = this.events[eventIndex];
    if (!event) return;

    // イベントのデータからコンテンツハッシュを計算
    const contentHash = event.data
      ? await this.computeHash(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
      : '';

    const checkpoint: CheckpointData = {
      eventIndex,
      hash: event.hash,
      timestamp: event.timestamp,
      contentHash
    };

    this.checkpoints.push(checkpoint);
    console.log(`[TypingProof] Checkpoint created at event ${eventIndex}, hash: ${event.hash.substring(0, 16)}...`);
  }

  /**
   * 入力タイプが許可されているかチェック
   */
  isAllowedInputType(inputType: InputType): boolean {
    const allowedTypes: InputType[] = [
      'insertText',
      'insertLineBreak',
      'insertParagraph',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
      'deleteByDrag',
      'historyUndo',
      'historyRedo',
      'insertCompositionText',
      'deleteCompositionText',
      'insertFromComposition'
    ];

    return allowedTypes.includes(inputType);
  }

  /**
   * 禁止される操作かチェック
   */
  isProhibitedInputType(inputType: InputType): boolean {
    const prohibitedTypes: InputType[] = [
      'insertFromPaste',
      'insertFromDrop',
      'insertFromYank',
      'insertReplacementText',
      'insertFromPasteAsQuotation'
    ];

    return prohibitedTypes.includes(inputType);
  }

  /**
   * 最終署名を生成
   */
  async generateSignature(): Promise<SignatureData> {
    const finalData = {
      totalEvents: this.events.length,
      finalHash: this.currentHash,
      startTime: this.startTime,
      endTime: performance.now()
    };

    const signatureData = JSON.stringify(finalData);
    const signature = await this.computeHash(signatureData);

    return {
      ...finalData,
      signature,
      events: this.events
    };
  }

  /**
   * 証明データをエクスポート
   * @param finalContent - 最終的なコード
   */
  async exportProof(finalContent: string): Promise<ExportedProof> {
    const signature = await this.generateSignature();

    // タイピング証明ハッシュを生成
    const typingProof = await this.generateTypingProofHash(finalContent);

    // 最終チェックポイントを作成（最後のイベントがチェックポイント間隔でない場合）
    const lastEventIndex = this.events.length - 1;
    if (lastEventIndex >= 0 && this.checkpoints.length === 0 ||
        (this.checkpoints.length > 0 && this.checkpoints[this.checkpoints.length - 1]!.eventIndex !== lastEventIndex)) {
      await this.createCheckpoint(lastEventIndex);
    }

    return {
      version: '3.2.0',
      typingProofHash: typingProof.typingProofHash,
      typingProofData: typingProof.proofData,
      proof: signature,
      fingerprint: {
        hash: this.fingerprint!,
        components: this.fingerprintComponents!
      },
      metadata: {
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        isPureTyping: typingProof.compact.isPureTyping
      },
      checkpoints: this.checkpoints
    };
  }

  /**
   * 統計情報を取得
   */
  getStats(): TypingStats {
    const duration = performance.now() - this.startTime;
    const eventTypes = this.events.reduce((acc, event) => {
      const eventType = event.type as EventType;
      acc[eventType] = (acc[eventType] ?? 0) + 1;
      return acc;
    }, {} as Record<EventType, number>);

    return {
      totalEvents: this.events.length,
      duration: duration / 1000,
      eventTypes,
      currentHash: this.currentHash,
      pendingCount: this.queuedEventCount
    };
  }

  /**
   * ハッシュ鎖を検証（PoSW検証含む）
   * @param onProgress - 進捗コールバック (current, total, hashInfo?) => void
   */
  async verify(onProgress?: (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => void): Promise<VerificationResult> {
    let hash = this.events[0]?.previousHash ?? null;
    let lastTimestamp = -Infinity;
    const total = this.events.length;

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (!event) continue;

      // シーケンス番号チェック
      if (event.sequence !== i) {
        return {
          valid: false,
          errorAt: i,
          message: `Sequence mismatch at event ${i}: expected ${i}, got ${event.sequence}`,
          event
        };
      }

      // タイムスタンプ連続性チェック
      if (event.timestamp < lastTimestamp) {
        return {
          valid: false,
          errorAt: i,
          message: `Timestamp violation at event ${i}: time moved backward from ${lastTimestamp.toFixed(2)}ms to ${event.timestamp.toFixed(2)}ms`,
          event,
          previousTimestamp: lastTimestamp,
          currentTimestamp: event.timestamp
        };
      }
      lastTimestamp = event.timestamp;

      // previousHashチェック（保存されたpreviousHashが期待値と一致するか）
      if (event.previousHash !== hash) {
        return {
          valid: false,
          errorAt: i,
          message: `Previous hash mismatch at event ${i}: stored previousHash doesn't match computed chain`,
          event,
          expectedHash: hash ?? undefined,
          computedHash: event.previousHash ?? undefined
        };
      }

      // PoSW検証のためのデータ（poswフィールドなし）
      const eventDataWithoutPoSW = {
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        inputType: event.inputType,
        data: event.data,
        rangeOffset: event.rangeOffset,
        rangeLength: event.rangeLength,
        range: event.range,
        previousHash: event.previousHash
      };

      // PoSW検証（決定的なJSON文字列化を使用）
      const eventDataStringForPoSW = this.deterministicStringify(eventDataWithoutPoSW);
      const poswValid = await this.verifyPoSW(hash ?? '', eventDataStringForPoSW, event.posw);

      if (!poswValid) {
        console.error(`[Verify] PoSW verification failed at event ${i}:`, {
          posw: event.posw,
          previousHash: hash
        });
        return {
          valid: false,
          errorAt: i,
          message: `PoSW verification failed at event ${i}: invalid proof of work`,
          event
        };
      }

      // recordEvent()で使用したのと同じフィールドを再構築（PoSW含む）
      const eventData: EventHashData = {
        ...eventDataWithoutPoSW,
        posw: event.posw
      };

      // 決定的なJSON文字列化を使用
      const eventString = this.deterministicStringify(eventData);
      const combinedData = hash + eventString;
      const computedHash = await this.computeHash(combinedData);

      if (computedHash !== event.hash) {
        console.error(`[Verify] Hash mismatch at event ${i}:`, {
          event,
          eventData,
          eventStringLength: eventString.length,
          previousHash: hash,
          expectedHash: event.hash,
          computedHash
        });
        return {
          valid: false,
          errorAt: i,
          message: `Hash mismatch at event ${i}`,
          event,
          eventData,
          expectedHash: event.hash,
          computedHash
        };
      }

      hash = event.hash;

      // 進捗を報告（UIスレッドに制御を戻すためにyield）
      if (onProgress) {
        onProgress(i + 1, total, {
          computed: computedHash,
          expected: event.hash,
          poswHash: event.posw.intermediateHash
        });
        // 毎回UIスレッドに制御を戻す（ハッシュ表示をリアルタイム更新）
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return {
      valid: true,
      message: 'All hashes verified successfully (including PoSW)'
    };
  }

  /**
   * 全てのイベントをクリアして初期状態に戻す
   */
  async reset(): Promise<void> {
    this.events = [];
    this.checkpoints = [];
    if (this.fingerprint) {
      this.currentHash = await this.initialHash(this.fingerprint);
    }
    this.startTime = performance.now();
  }

  /**
   * チェックポイントを使用したサンプリング検証
   * ランダムな区間をサンプリングして、開始ハッシュから再計算し終了ハッシュと一致するか検証
   * @param checkpoints - チェックポイントデータ
   * @param sampleCount - サンプリングする区間数（デフォルト: 3）
   * @param onProgress - 進捗コールバック
   */
  async verifySampled(
    checkpoints: CheckpointData[],
    sampleCount: number = 3,
    onProgress?: (phase: string, current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash?: string }) => void
  ): Promise<VerificationResult> {
    // チェックポイントがない場合は全検証にフォールバック
    if (!checkpoints || checkpoints.length === 0) {
      onProgress?.('fallback', 0, this.events.length);
      return await this.verify((current, total, hashInfo) => {
        onProgress?.('full', current, total, hashInfo);
      });
    }

    // チェックポイントをソート（念のため）
    const sortedCheckpoints = [...checkpoints].sort((a, b) => a.eventIndex - b.eventIndex);

    // 検証対象の区間を構築（チェックポイント間）
    const allSegments = this.buildCheckpointSegments(sortedCheckpoints);

    // ランダムにサンプリング
    const selectedSegments = this.selectRandomSegments(allSegments, sampleCount);

    // 検証対象のイベント総数を計算
    let totalEventsToVerify = 0;
    for (const seg of selectedSegments) {
      totalEventsToVerify += seg.endIndex - seg.startIndex + 1;
    }

    onProgress?.('checkpoint', 0, selectedSegments.length);

    // サンプリング結果を記録
    const sampledSegmentInfos: SampledSegmentInfo[] = [];

    // 各区間を再計算して検証
    let verifiedCount = 0;
    for (let segIdx = 0; segIdx < selectedSegments.length; segIdx++) {
      const segment = selectedSegments[segIdx]!;

      // 区間を再計算検証（開始ハッシュから計算し、終了ハッシュと一致するか）
      const result = await this.verifySegmentWithExpectedEnd(
        segment.startIndex,
        segment.endIndex,
        segment.startHash,
        segment.expectedEndHash,
        (_current, _total, hashInfo) => {
          verifiedCount++;
          onProgress?.('segment', verifiedCount, totalEventsToVerify, hashInfo);
        }
      );

      // サンプリング結果を記録
      sampledSegmentInfos.push({
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        eventCount: segment.endIndex - segment.startIndex + 1,
        startHash: segment.startHash,
        endHash: segment.expectedEndHash,
        verified: result.valid
      });

      if (!result.valid) {
        return {
          ...result,
          sampledResult: {
            sampledSegments: sampledSegmentInfos,
            totalSegments: allSegments.length,
            totalEventsVerified: verifiedCount,
            totalEvents: this.events.length
          }
        };
      }

      onProgress?.('checkpoint', segIdx + 1, selectedSegments.length, {
        computed: result.computedHash ?? '',
        expected: segment.expectedEndHash
      });
    }

    return {
      valid: true,
      message: `Sampling verification passed (${selectedSegments.length} segments, ${verifiedCount} events verified out of ${this.events.length} total)`,
      sampledResult: {
        sampledSegments: sampledSegmentInfos,
        totalSegments: allSegments.length,
        totalEventsVerified: verifiedCount,
        totalEvents: this.events.length
      }
    };
  }

  /**
   * チェックポイント間の区間を構築
   * 各区間は開始ハッシュと期待される終了ハッシュを持つ
   */
  private buildCheckpointSegments(
    checkpoints: CheckpointData[]
  ): Array<{ startIndex: number; endIndex: number; startHash: string; expectedEndHash: string }> {
    const segments: Array<{ startIndex: number; endIndex: number; startHash: string; expectedEndHash: string }> = [];

    // 最初の区間: イベント0 から 最初のチェックポイントまで
    if (checkpoints.length > 0 && checkpoints[0]!.eventIndex >= 0) {
      const firstCp = checkpoints[0]!;
      segments.push({
        startIndex: 0,
        endIndex: firstCp.eventIndex,
        startHash: this.events[0]?.previousHash ?? '',
        expectedEndHash: firstCp.hash
      });
    }

    // チェックポイント間の区間
    for (let i = 0; i < checkpoints.length - 1; i++) {
      const currentCp = checkpoints[i]!;
      const nextCp = checkpoints[i + 1]!;

      // 次のチェックポイントまでの区間（現在のチェックポイントの次から）
      segments.push({
        startIndex: currentCp.eventIndex + 1,
        endIndex: nextCp.eventIndex,
        startHash: currentCp.hash,
        expectedEndHash: nextCp.hash
      });
    }

    // 最後の区間: 最後のチェックポイントから最終イベントまで
    const lastCp = checkpoints[checkpoints.length - 1];
    if (lastCp && lastCp.eventIndex < this.events.length - 1) {
      const lastEvent = this.events[this.events.length - 1];
      segments.push({
        startIndex: lastCp.eventIndex + 1,
        endIndex: this.events.length - 1,
        startHash: lastCp.hash,
        expectedEndHash: lastEvent?.hash ?? ''
      });
    }

    return segments;
  }

  /**
   * 区間からランダムにサンプリング
   * 必ず最初と最後の区間を含め、残りはランダム選択
   */
  private selectRandomSegments(
    segments: Array<{ startIndex: number; endIndex: number; startHash: string; expectedEndHash: string }>,
    sampleCount: number
  ): Array<{ startIndex: number; endIndex: number; startHash: string; expectedEndHash: string }> {
    if (segments.length <= sampleCount) {
      return segments;
    }

    const selected: Array<{ startIndex: number; endIndex: number; startHash: string; expectedEndHash: string }> = [];

    // 必ず最初と最後の区間を含める
    selected.push(segments[0]!);
    if (segments.length > 1) {
      selected.push(segments[segments.length - 1]!);
    }

    // 残りの区間からランダムにサンプリング
    const middleSegments = segments.slice(1, -1);
    const remaining = sampleCount - selected.length;

    for (let i = 0; i < remaining && middleSegments.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * middleSegments.length);
      selected.push(middleSegments.splice(randomIndex, 1)[0]!);
    }

    // インデックス順にソート
    return selected.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * 区間を再計算検証し、期待される終了ハッシュと一致するか確認
   */
  private async verifySegmentWithExpectedEnd(
    startIndex: number,
    endIndex: number,
    startHash: string,
    expectedEndHash: string,
    onProgress?: (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => void
  ): Promise<VerificationResult & { computedHash?: string }> {
    let hash: string | null = startIndex === 0 ? (this.events[0]?.previousHash ?? null) : startHash;
    let lastTimestamp = startIndex > 0 ? (this.events[startIndex - 1]?.timestamp ?? -Infinity) : -Infinity;
    const total = endIndex - startIndex + 1;

    for (let i = startIndex; i <= endIndex; i++) {
      const event = this.events[i];
      if (!event) continue;

      // シーケンス番号チェック
      if (event.sequence !== i) {
        return {
          valid: false,
          errorAt: i,
          message: `Sequence mismatch at event ${i}: expected ${i}, got ${event.sequence}`,
          event
        };
      }

      // タイムスタンプ連続性チェック
      if (event.timestamp < lastTimestamp) {
        return {
          valid: false,
          errorAt: i,
          message: `Timestamp violation at event ${i}`,
          event,
          previousTimestamp: lastTimestamp,
          currentTimestamp: event.timestamp
        };
      }
      lastTimestamp = event.timestamp;

      // PoSW検証のためのデータ
      const eventDataWithoutPoSW = {
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        inputType: event.inputType,
        data: event.data,
        rangeOffset: event.rangeOffset,
        rangeLength: event.rangeLength,
        range: event.range,
        previousHash: event.previousHash
      };

      // PoSW検証（決定的なJSON文字列化を使用）
      const eventDataStringForPoSW = this.deterministicStringify(eventDataWithoutPoSW);
      const poswValid = await this.verifyPoSW(hash ?? '', eventDataStringForPoSW, event.posw);

      if (!poswValid) {
        return {
          valid: false,
          errorAt: i,
          message: `PoSW verification failed at event ${i}`,
          event
        };
      }

      // ハッシュ計算（決定的なJSON文字列化を使用）
      const eventData: EventHashData = {
        ...eventDataWithoutPoSW,
        posw: event.posw
      };

      const eventString = this.deterministicStringify(eventData);
      const combinedData = hash + eventString;
      const computedHash = await this.computeHash(combinedData);

      hash = computedHash;

      if (onProgress) {
        onProgress(i - startIndex + 1, total, {
          computed: computedHash,
          expected: event.hash,
          poswHash: event.posw.intermediateHash
        });
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // 区間の終了ハッシュが期待値と一致するか確認
    if (hash !== expectedEndHash) {
      return {
        valid: false,
        errorAt: endIndex,
        message: `Segment end hash mismatch at event ${endIndex}: computed ${hash?.substring(0, 16)}..., expected ${expectedEndHash.substring(0, 16)}...`,
        expectedHash: expectedEndHash,
        computedHash: hash ?? undefined
      };
    }

    return {
      valid: true,
      message: `Segment ${startIndex}-${endIndex} verified successfully`,
      computedHash: hash ?? undefined
    };
  }

  /**
   * コンテンツスナップショットを記録
   * @param editorContent - エディタの全コンテンツ
   */
  async recordContentSnapshot(editorContent: string): Promise<RecordEventResult> {
    return await this.recordEvent({
      type: 'contentSnapshot',
      data: editorContent,
      description: `スナップショット（イベント${this.events.length}）`,
      isSnapshot: true
    });
  }

  /**
   * タイピング統計を取得
   */
  getTypingStatistics(): TypingStatistics {
    let pasteEvents = 0;
    let dropEvents = 0;
    let insertEvents = 0;
    let deleteEvents = 0;

    for (const event of this.events) {
      if (event.inputType === 'insertFromPaste') pasteEvents++;
      if (event.inputType === 'insertFromDrop') dropEvents++;
      if (event.type === 'contentChange' && event.data) insertEvents++;
      if (event.inputType?.startsWith('delete')) deleteEvents++;
    }

    const duration = performance.now() - this.startTime;
    const averageWPM = insertEvents / (duration / 60000);

    return {
      totalEvents: this.events.length,
      pasteEvents,
      dropEvents,
      insertEvents,
      deleteEvents,
      duration,
      averageWPM: Math.round(averageWPM * 10) / 10
    };
  }

  /**
   * タイピング証明ハッシュを生成
   * @param finalContent - 最終的なコード
   */
  async generateTypingProofHash(finalContent: string): Promise<TypingProofHashResult> {
    const finalContentHash = await this.computeHash(finalContent);
    const stats = this.getTypingStatistics();

    const proofData: ProofData = {
      finalContentHash,
      finalEventChainHash: this.currentHash!,
      deviceId: this.fingerprint!,
      metadata: {
        totalEvents: stats.totalEvents,
        pasteEvents: stats.pasteEvents,
        dropEvents: stats.dropEvents,
        insertEvents: stats.insertEvents,
        deleteEvents: stats.deleteEvents,
        totalTypingTime: stats.duration,
        averageTypingSpeed: stats.averageWPM
      }
    };

    const proofString = JSON.stringify(proofData);
    const typingProofHash = await this.computeHash(proofString);

    return {
      typingProofHash,
      proofData,
      compact: {
        hash: typingProofHash,
        content: finalContent,
        isPureTyping: stats.pasteEvents === 0 && stats.dropEvents === 0,
        deviceId: this.fingerprint!,
        totalEvents: stats.totalEvents
      }
    };
  }

  /**
   * タイピング証明ハッシュを検証
   * @param typingProofHash - 検証するハッシュ
   * @param proofData - 証明データ
   * @param finalContent - 最終コード
   */
  async verifyTypingProofHash(
    typingProofHash: string,
    proofData: ProofData,
    finalContent: string
  ): Promise<TypingProofVerificationResult> {
    const computedContentHash = await this.computeHash(finalContent);

    if (computedContentHash !== proofData.finalContentHash) {
      return {
        valid: false,
        reason: 'Final content does not match the proof'
      };
    }

    const proofString = JSON.stringify(proofData);
    const computedProofHash = await this.computeHash(proofString);

    if (computedProofHash !== typingProofHash) {
      return {
        valid: false,
        reason: 'Proof hash does not match'
      };
    }

    const isPureTyping =
      proofData.metadata.pasteEvents === 0 &&
      proofData.metadata.dropEvents === 0;

    return {
      valid: true,
      isPureTyping,
      deviceId: proofData.deviceId,
      metadata: proofData.metadata
    };
  }

  /**
   * 状態をシリアライズ（localStorage保存用）
   */
  serializeState(): SerializedProofState {
    return {
      events: this.events,
      currentHash: this.currentHash,
      startTime: this.startTime
    };
  }

  /**
   * シリアライズされた状態から復元
   * @param state - シリアライズされた状態
   */
  restoreState(state: SerializedProofState): void {
    this.events = state.events;
    this.currentHash = state.currentHash;
    this.startTime = state.startTime;
  }

  /**
   * シリアライズされた状態から新しいインスタンスを作成
   * @param state - シリアライズされた状態
   * @param fingerprintHash - フィンガープリントハッシュ
   * @param fingerprintComponents - フィンガープリント構成要素
   * @param externalWorker - 外部から提供されたWorker（symlinkedパッケージ対応）
   */
  static async fromSerializedState(
    state: SerializedProofState,
    fingerprintHash: string,
    fingerprintComponents: FingerprintComponents,
    externalWorker?: Worker
  ): Promise<TypingProof> {
    const proof = new TypingProof();
    proof.fingerprint = fingerprintHash;
    proof.fingerprintComponents = fingerprintComponents;
    proof.restoreState(state);
    proof.initWorker(externalWorker);
    proof.initialized = true;
    return proof;
  }
}
