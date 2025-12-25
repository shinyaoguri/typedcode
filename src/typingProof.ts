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
} from './types.js';

export class TypingProof {
  events: StoredEvent[] = [];
  currentHash: string | null = null;
  fingerprint: string | null = null;
  fingerprintComponents: FingerprintComponents | null = null;
  startTime: number = performance.now();
  initialized: boolean = false;
  private recordQueue: Promise<RecordEventResult> = Promise.resolve({ hash: '', index: -1 });

  // PoSW設定（固定値 - セキュリティ上の理由で動的変更は不可）
  private static readonly POSW_ITERATIONS = 5000;

  // Web Worker関連
  private worker: Worker | null = null;
  private requestIdCounter: number = 0;
  private pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = new Map();

  /**
   * Web Workerを初期化
   */
  private initWorker(): void {
    if (this.worker) return;

    this.worker = new Worker(
      new URL('./poswWorker.ts', import.meta.url),
      { type: 'module' }
    );

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
    };
  }

  /**
   * Workerにリクエストを送信して結果を待つ
   */
  private sendWorkerRequest<T>(request: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const requestId = ++this.requestIdCounter;
      this.pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...request, requestId });
    });
  }

  /**
   * 初期化（非同期）
   * フィンガープリントを生成して初期ハッシュを設定
   */
  async initialize(
    fingerprintHash: string,
    fingerprintComponents: FingerprintComponents
  ): Promise<void> {
    this.fingerprint = fingerprintHash;
    this.fingerprintComponents = fingerprintComponents;
    this.currentHash = await this.initialHash(fingerprintHash);

    // Web Workerを初期化
    this.initWorker();

    console.log('[TypingProof] Initialized with fixed PoSW iterations:', TypingProof.POSW_ITERATIONS);

    this.initialized = true;
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
   * @returns ハッシュと配列のインデックス
   */
  async recordEvent(event: RecordEventInput): Promise<RecordEventResult> {
    // 前のイベント記録が完了するまで待つ（排他制御）
    this.recordQueue = this.recordQueue.then(() => this._recordEventInternal(event));
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
    const eventDataString = JSON.stringify(eventDataWithoutPoSW);
    const posw = await this.computePoSW(this.currentHash ?? '', eventDataString);

    // ハッシュ計算に使用するフィールド（PoSW含む）
    const eventData: EventHashData = {
      ...eventDataWithoutPoSW,
      posw
    };

    // イベントデータを文字列化してハッシュ計算
    const eventString = JSON.stringify(eventData);
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

    return { hash: this.currentHash, index: eventIndex };
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

    return {
      version: '3.0.0',
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
      }
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
      currentHash: this.currentHash
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

      // PoSW検証
      const eventDataStringForPoSW = JSON.stringify(eventDataWithoutPoSW);
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

      const eventString = JSON.stringify(eventData);
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
    if (this.fingerprint) {
      this.currentHash = await this.initialHash(this.fingerprint);
    }
    this.startTime = performance.now();
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
}
