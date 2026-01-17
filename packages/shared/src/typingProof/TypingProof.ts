/**
 * TypingProof - タイピング証明システム
 * コピペを禁止し、全ての操作をハッシュ鎖として記録
 *
 * このクラスは各種Managerへのファサードとして機能し、
 * 既存のPublic APIを維持しながら内部実装を委譲する
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
  PoSWData,
  SerializedProofState,
  LightweightProofState,
  CheckpointData,
  HumanAttestationEventData,
  TemplateInjectionEventData,
  PendingEventData,
} from '../types.js';
import { PROOF_FORMAT_VERSION } from '../version.js';
import { HashChainManager } from './HashChainManager.js';
import { PoswManager } from './PoswManager.js';
import { CheckpointManager } from './CheckpointManager.js';
import { ChainVerifier } from './ChainVerifier.js';
import { StatisticsCalculator } from './StatisticsCalculator.js';
import { isAllowedInputType, isProhibitedInputType } from './InputTypeValidator.js';

export class TypingProof {
  events: StoredEvent[] = [];
  fingerprint: string | null = null;
  fingerprintComponents: FingerprintComponents | null = null;
  startTime: number = performance.now();
  initialized: boolean = false;
  private recordQueue: Promise<RecordEventResult> = Promise.resolve({ hash: '', index: -1 });
  private queuedEventCount: number = 0;

  /**
   * PoSW計算が完了していないイベント
   * リロード時に保存され、復旧時にPoSW計算を完了させる
   */
  private pendingEvents: PendingEventData[] = [];

  /**
   * Pending Eventが変更されたときに呼ばれるコールバック
   * sessionStorageへの即時保存に使用
   */
  private onPendingEventChange: ((pending: PendingEventData[]) => void) | null = null;

  // 内部マネージャー
  private hashChainManager: HashChainManager;
  private poswManager: PoswManager;
  private checkpointManager: CheckpointManager;
  private chainVerifier: ChainVerifier;
  private statisticsCalculator: StatisticsCalculator;

  constructor() {
    this.hashChainManager = new HashChainManager();
    this.poswManager = new PoswManager(this.hashChainManager);
    this.checkpointManager = new CheckpointManager(this.hashChainManager);
    this.chainVerifier = new ChainVerifier(this.hashChainManager, this.poswManager);
    this.statisticsCalculator = new StatisticsCalculator();
  }

  // currentHashへのアクセサ（後方互換性のため）
  get currentHash(): string | null {
    return this.hashChainManager.getCurrentHash();
  }

  set currentHash(value: string | null) {
    this.hashChainManager.setCurrentHash(value);
  }

  // checkpointsへのアクセサ（後方互換性のため）
  get checkpoints(): CheckpointData[] {
    return this.checkpointManager.getCheckpoints();
  }

  set checkpoints(value: CheckpointData[]) {
    this.checkpointManager.setCheckpoints(value);
  }

  /**
   * Web Workerを初期化
   * @param externalWorker - 外部から提供されたWorker（symlinkedパッケージ対応）
   */
  initWorker(externalWorker?: Worker): void {
    this.poswManager.initWorker(externalWorker);
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
    this.hashChainManager.setCurrentHash(await this.hashChainManager.initialHash(fingerprintHash));

    // Web Workerを初期化
    this.poswManager.initWorker(externalWorker);

    console.log('[TypingProof] Initialized with fixed PoSW iterations:', this.poswManager.getPoSWIterations());

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
   * テンプレート注入イベントを記録
   * paste/dropとは異なり、isPureTypingには影響しない
   * @param injectionData - テンプレート注入データ
   */
  async recordTemplateInjection(injectionData: TemplateInjectionEventData): Promise<RecordEventResult> {
    return await this.recordEvent({
      type: 'templateInjection',
      data: injectionData,
      description: `Template "${injectionData.templateName}" - ${injectionData.filename} (${injectionData.contentLength} chars)`,
    });
  }

  /**
   * 初期ハッシュを生成（フィンガープリント + ランダム値）
   */
  async initialHash(fingerprintHash: string): Promise<string> {
    return await this.hashChainManager.initialHash(fingerprintHash);
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
    return this.hashChainManager.arrayBufferToHex(buffer);
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data: string): Promise<string> {
    return await this.hashChainManager.computeHash(data);
  }

  /**
   * Proof of Sequential Work を計算（Worker使用）
   */
  async computePoSW(previousHash: string, eventDataString: string): Promise<PoSWData> {
    return await this.poswManager.computePoSW(previousHash, eventDataString);
  }

  /**
   * PoSWを検証（Worker使用、フォールバックあり）
   */
  async verifyPoSW(previousHash: string, eventDataString: string, posw: PoSWData): Promise<boolean> {
    return await this.poswManager.verifyPoSW(previousHash, eventDataString, posw);
  }

  /**
   * PoSW反復回数を取得（固定値）
   */
  getPoSWIterations(): number {
    return this.poswManager.getPoSWIterations();
  }

  /**
   * イベントを記録してハッシュ鎖を更新（排他制御付き）
   * エラーが発生しても可能な限りチェーンを継続し、部分的な検証を可能にする
   *
   * 2段階記録方式:
   * 1. イベントをpendingEventsに追加（即時、同期的）→ コールバックでsessionStorage保存
   * 2. PoSW計算後にevents配列に追加、pendingEventsから削除
   *
   * @param event イベント入力データ
   * @param tabId タブID（Pending Event保存用、省略時は空文字）
   * @returns ハッシュと配列のインデックス
   * @throws 初期化前に呼び出された場合はエラー
   */
  async recordEvent(event: RecordEventInput, tabId: string = ''): Promise<RecordEventResult> {
    // 初期化チェック
    if (!this.initialized) {
      throw new Error('TypingProof not initialized. Call initialize() first.');
    }

    // キュー待ち数を増加
    this.queuedEventCount++;

    // Phase 1: Pending Eventを即座に作成・保存（同期的）
    const timestamp = performance.now() - this.startTime;
    const sequence = this.events.length + this.pendingEvents.length;
    const pendingEvent: PendingEventData = {
      input: {
        type: event.type,
        inputType: event.inputType,
        data: event.data,
        rangeOffset: event.rangeOffset,
        rangeLength: event.rangeLength,
        range: event.range,
        description: event.description,
        isMultiLine: event.isMultiLine,
        deletedLength: event.deletedLength,
        insertedText: event.insertedText,
        insertLength: event.insertLength,
        deleteDirection: event.deleteDirection,
        selectedText: event.selectedText,
      },
      timestamp,
      sequence,
      previousHash: this.currentHash,
      tabId,
      createdAt: Date.now(),
    };

    this.pendingEvents.push(pendingEvent);

    // コールバックで即時保存（sessionStorage）
    this.onPendingEventChange?.(this.pendingEvents);

    // Phase 2: PoSW計算（非同期）
    // 前のイベント記録が完了するまで待つ（排他制御）
    // エラーが発生してもチェーンを継続させる
    this.recordQueue = this.recordQueue
      .catch(() => {
        // 前のイベントでエラーが発生してもチェーンを継続
      })
      .then(async () => {
        try {
          const result = await this._recordEventInternal(event, pendingEvent);
          // PoSW計算完了後、pendingEventsから削除
          const idx = this.pendingEvents.indexOf(pendingEvent);
          if (idx >= 0) {
            this.pendingEvents.splice(idx, 1);
            this.onPendingEventChange?.(this.pendingEvents);
          }
          return result;
        } catch (error) {
          // エラー発生時もログを出力するがチェーンは継続
          console.error('[TypingProof] Event recording error (chain continues):', error);
          // pendingEventsから削除（エラー時も）
          const idx = this.pendingEvents.indexOf(pendingEvent);
          if (idx >= 0) {
            this.pendingEvents.splice(idx, 1);
            this.onPendingEventChange?.(this.pendingEvents);
          }
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
  private async _recordEventInternal(
    event: RecordEventInput,
    pendingEvent: PendingEventData
  ): Promise<RecordEventResult> {
    // 1. シーケンス番号の検証・修正
    const sequenceResult = this.hashChainManager.validateSequence(
      pendingEvent.sequence,
      this.events.length
    );
    const sequence = sequenceResult.sequence;
    if (sequenceResult.wasCorrected) {
      pendingEvent.sequence = sequence;
    }

    // 2. タイムスタンプの単調増加保証
    const lastTimestamp = this.events[this.events.length - 1]?.timestamp ?? -Infinity;
    const timestampResult = this.hashChainManager.ensureMonotonicTimestamp(
      pendingEvent.timestamp,
      lastTimestamp
    );
    const timestamp = timestampResult.timestamp;
    if (timestampResult.wasAdjusted) {
      pendingEvent.timestamp = timestamp;
    }

    // 3. previousHashの整合性検証
    const previousHash = this.hashChainManager.validatePreviousHash(
      pendingEvent.previousHash,
      this.currentHash
    );
    if (pendingEvent.previousHash !== previousHash) {
      pendingEvent.previousHash = previousHash;
    }

    // 4. イベントデータの構築（PoSW計算前）
    const eventDataWithoutPoSW = {
      sequence,
      timestamp,
      type: event.type,
      inputType: event.inputType ?? null,
      data: event.data ?? null,
      rangeOffset: event.rangeOffset ?? null,
      rangeLength: event.rangeLength ?? null,
      range: event.range ?? null,
      previousHash
    };

    // 5. PoSW計算
    const eventDataString = this.hashChainManager.deterministicStringify(eventDataWithoutPoSW);
    const posw = await this.poswManager.computePoSW(this.currentHash ?? '', eventDataString);

    // 6. ハッシュ計算
    const eventData: EventHashData = { ...eventDataWithoutPoSW, posw };
    const eventString = this.hashChainManager.deterministicStringify(eventData);
    const newHash = await this.hashChainManager.computeHash(this.currentHash + eventString);
    this.hashChainManager.setCurrentHash(newHash);

    // 7. デバッグログ（最初の10イベントのみ）
    if (this.events.length < 10) {
      console.log(`[Record] Event ${this.events.length}:`, {
        type: event.type,
        sequence,
        timestamp: timestamp.toFixed(2),
        poswIterations: posw.iterations,
        poswTimeMs: posw.computeTimeMs.toFixed(2),
        hash: newHash
      });
    }

    // 8. イベントの保存
    const eventIndex = this.events.length;
    const storedEvent: StoredEvent = {
      ...eventData,
      hash: newHash,
      description: event.description ?? null,
      isMultiLine: event.isMultiLine ?? null,
      deletedLength: event.deletedLength ?? null,
      insertedText: event.insertedText ?? null,
      insertLength: event.insertLength ?? null,
      deleteDirection: event.deleteDirection ?? null,
      selectedText: event.selectedText ?? null
    };
    this.events.push(storedEvent);

    // 9. チェックポイントの自動作成
    if (this.checkpointManager.shouldCreateCheckpoint(eventIndex)) {
      await this.checkpointManager.createCheckpoint(eventIndex, this.events);
    }

    return { hash: newHash, index: eventIndex };
  }

  /**
   * 入力タイプが許可されているかチェック
   */
  isAllowedInputType(inputType: InputType): boolean {
    return isAllowedInputType(inputType);
  }

  /**
   * 禁止される操作かチェック
   */
  isProhibitedInputType(inputType: InputType): boolean {
    return isProhibitedInputType(inputType);
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
    const signature = await this.hashChainManager.computeHash(signatureData);

    // エクスポート用にメタデータのnullフィールドを省略
    const compactEvents = this.events.map(event => this.compactEventForExport(event));

    return {
      ...finalData,
      signature,
      events: compactEvents
    };
  }

  /**
   * エクスポート用にイベントを最適化
   * ハッシュ計算に使用されないメタデータフィールドのみnullを省略
   * @private
   */
  private compactEventForExport(event: StoredEvent): StoredEvent {
    // メタデータフィールド（ハッシュ計算に使用されない）のnullを省略
    const compact: Partial<StoredEvent> = {
      // ハッシュ計算フィールド（必須）
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      inputType: event.inputType,
      data: event.data,
      rangeOffset: event.rangeOffset,
      rangeLength: event.rangeLength,
      range: event.range,
      previousHash: event.previousHash,
      posw: event.posw,
      hash: event.hash,
    };

    // メタデータフィールド（nullでなければ追加）
    if (event.description !== null) compact.description = event.description;
    if (event.isMultiLine !== null) compact.isMultiLine = event.isMultiLine;
    if (event.deletedLength !== null) compact.deletedLength = event.deletedLength;
    if (event.insertedText !== null) compact.insertedText = event.insertedText;
    if (event.insertLength !== null) compact.insertLength = event.insertLength;
    if (event.deleteDirection !== null) compact.deleteDirection = event.deleteDirection;
    if (event.selectedText !== null) compact.selectedText = event.selectedText;

    return compact as StoredEvent;
  }

  /**
   * 証明データをエクスポート
   * @param finalContent - 最終的なコード
   */
  async exportProof(finalContent: string): Promise<ExportedProof> {
    const signature = await this.generateSignature();

    // タイピング証明ハッシュを生成
    const typingProof = await this.generateTypingProofHash(finalContent);

    // チェックポイントをクリーンアップして最終チェックポイントを作成
    const lastEventIndex = this.events.length - 1;
    if (lastEventIndex >= 0) {
      // 正規のチェックポイント以外を削除
      this.checkpointManager.cleanupForExport();

      // 最終イベントにチェックポイントを作成（まだ存在しない場合）
      const lastCheckpoint = this.checkpointManager.getLastCheckpoint();
      if (!lastCheckpoint || lastCheckpoint.eventIndex !== lastEventIndex) {
        await this.checkpointManager.createCheckpoint(lastEventIndex, this.events);
      }
    }

    return {
      version: PROOF_FORMAT_VERSION,
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
      checkpoints: this.checkpointManager.getCheckpoints()
    };
  }

  /**
   * 統計情報を取得
   */
  getStats(): TypingStats {
    return this.statisticsCalculator.getStats(
      this.events,
      this.startTime,
      this.currentHash,
      this.queuedEventCount
    );
  }

  /**
   * ハッシュ鎖を検証（PoSW検証含む）
   * @param onProgress - 進捗コールバック (current, total, hashInfo?) => void
   */
  async verify(onProgress?: (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => void): Promise<VerificationResult> {
    return await this.chainVerifier.verify(this.events, onProgress);
  }

  /**
   * 全てのイベントをクリアして初期状態に戻す
   */
  async reset(): Promise<void> {
    this.events = [];
    this.checkpointManager.clearCheckpoints();
    if (this.fingerprint) {
      this.hashChainManager.setCurrentHash(await this.hashChainManager.initialHash(this.fingerprint));
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
    return await this.chainVerifier.verifySampled(this.events, checkpoints, sampleCount, onProgress);
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
    return this.statisticsCalculator.getTypingStatistics(this.events, this.startTime);
  }

  /**
   * タイピング証明ハッシュを生成
   * @param finalContent - 最終的なコード
   */
  async generateTypingProofHash(finalContent: string): Promise<TypingProofHashResult> {
    const finalContentHash = await this.hashChainManager.computeHash(finalContent);
    const stats = this.getTypingStatistics();

    const proofData: ProofData = {
      finalContentHash,
      finalEventChainHash: this.currentHash!,
      deviceId: this.fingerprint!,
      metadata: {
        totalEvents: stats.totalEvents,
        pasteEvents: stats.pasteEvents,
        internalPasteEvents: stats.internalPasteEvents,
        dropEvents: stats.dropEvents,
        insertEvents: stats.insertEvents,
        deleteEvents: stats.deleteEvents,
        totalTypingTime: stats.duration,
        averageTypingSpeed: stats.averageWPM
      }
    };

    const proofString = JSON.stringify(proofData);
    const typingProofHash = await this.hashChainManager.computeHash(proofString);

    // isPureTyping: 外部ペースト/ドロップがない場合はtrue
    // 内部ペーストは許可されているため、isPureTypingには影響しない
    const isPureTyping = stats.pasteEvents === 0 && stats.dropEvents === 0;

    return {
      typingProofHash,
      proofData,
      compact: {
        hash: typingProofHash,
        content: finalContent,
        isPureTyping,
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
    const computedContentHash = await this.hashChainManager.computeHash(finalContent);

    if (computedContentHash !== proofData.finalContentHash) {
      return {
        valid: false,
        reason: 'Final content does not match the proof'
      };
    }

    const proofString = JSON.stringify(proofData);
    const computedProofHash = await this.hashChainManager.computeHash(proofString);

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
      startTime: this.startTime,
      pendingEvents: [...this.pendingEvents],
      checkpoints: [...this.checkpointManager.getCheckpoints()],
    };
  }

  /**
   * 軽量状態をシリアライズ（sessionStorage用、eventsなし）
   * V2フォーマット用：イベントはIndexedDBに保存されるため、
   * sessionStorageにはメタデータのみ保存する
   */
  serializeLightweightState(): LightweightProofState {
    return {
      lastEventSequence: this.events.length - 1,
      currentHash: this.currentHash,
      startTime: this.startTime,
      // pendingEventsは復元時に使用しないため保存しない
      checkpoints: [...this.checkpointManager.getCheckpoints()],
    };
  }

  /**
   * シリアライズされた状態から復元
   * @param state - シリアライズされた状態
   */
  restoreState(state: SerializedProofState): void {
    this.events = state.events;
    this.hashChainManager.setCurrentHash(state.currentHash);

    // タイムスタンプの単調増加を保証するためにstartTimeを調整
    // 最後のイベントのタイムスタンプを取得し、次のイベントがそれより大きくなるようにする
    const lastEvent = this.events[this.events.length - 1];
    if (lastEvent) {
      // 現在の performance.now() から、最後のイベントのタイムスタンプ + マージンを引いた値を startTime とする
      // これにより、次のイベントのタイムスタンプは lastTimestamp + マージン 以上になる
      const lastTimestamp = lastEvent.timestamp;
      const margin = 10; // 10ms のマージンを追加
      this.startTime = performance.now() - (lastTimestamp + margin);
      console.log(`[TypingProof] Adjusted startTime for session resume: lastTimestamp=${lastTimestamp.toFixed(2)}, newStartTime=${this.startTime.toFixed(2)}`);
    } else {
      this.startTime = state.startTime;
    }

    // Pending Eventsは復元しない（リロード時に失われる）
    // PoSW計算中だったイベントはリロードで失われるが、エクスポート時には
    // waitForProcessingComplete()でPoSW計算完了を待機するため整合性は保証される
    this.pendingEvents = [];

    // チェックポイントを復元（サンプリング検証用）
    if (state.checkpoints && state.checkpoints.length > 0) {
      this.checkpointManager.setCheckpoints([...state.checkpoints]);
    }
  }

  /**
   * Pending Eventsを取得
   */
  getPendingEvents(): PendingEventData[] {
    return [...this.pendingEvents];
  }

  /**
   * Pending Event変更コールバックを設定
   */
  setOnPendingEventChange(callback: ((pending: PendingEventData[]) => void) | null): void {
    this.onPendingEventChange = callback;
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

    // Pending Eventsは復元しない（restoreStateで空配列に設定済み）

    return proof;
  }
}
