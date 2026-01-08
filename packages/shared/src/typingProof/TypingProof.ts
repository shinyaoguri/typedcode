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
    const sequence = this.events.length; // 実際のsequenceはevents配列の長さ

    // タイムスタンプの単調増加を保証
    // 最後のイベントのタイムスタンプより大きくなるように調整
    const lastEvent = this.events[this.events.length - 1];
    const lastTimestamp = lastEvent?.timestamp ?? -Infinity;
    let timestamp = pendingEvent.timestamp;

    if (timestamp <= lastTimestamp) {
      // タイムスタンプが後退している場合、最後のタイムスタンプ + マージンに調整
      const adjustedTimestamp = lastTimestamp + 10; // 10ms のマージン
      console.log(`[TypingProof] Adjusting timestamp for monotonicity: ${timestamp.toFixed(2)} -> ${adjustedTimestamp.toFixed(2)} (last: ${lastTimestamp.toFixed(2)})`);
      timestamp = adjustedTimestamp;
      pendingEvent.timestamp = adjustedTimestamp; // pendingEvent も更新
    }

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
    const eventDataString = this.hashChainManager.deterministicStringify(eventDataWithoutPoSW);
    const posw = await this.poswManager.computePoSW(this.currentHash ?? '', eventDataString);

    // ハッシュ計算に使用するフィールド（PoSW含む）
    const eventData: EventHashData = {
      ...eventDataWithoutPoSW,
      posw
    };

    // イベントデータを決定的に文字列化してハッシュ計算
    const eventString = this.hashChainManager.deterministicStringify(eventData);
    const combinedData = this.currentHash + eventString;
    const newHash = await this.hashChainManager.computeHash(combinedData);
    this.hashChainManager.setCurrentHash(newHash);

    // デバッグ: ハッシュ計算に使用したデータをログ出力
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

    // イベントを保存（ハッシュ計算に使用したフィールド + 追加のメタデータ）
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

    // チェックポイントの自動作成（CHECKPOINT_INTERVALイベントごと）
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
        dropEvents: stats.dropEvents,
        insertEvents: stats.insertEvents,
        deleteEvents: stats.deleteEvents,
        totalTypingTime: stats.duration,
        averageTypingSpeed: stats.averageWPM
      }
    };

    const proofString = JSON.stringify(proofData);
    const typingProofHash = await this.hashChainManager.computeHash(proofString);

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

    this.pendingEvents = state.pendingEvents ?? [];
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
   * Pending Eventsを設定（復旧用）
   */
  setPendingEvents(events: PendingEventData[]): void {
    this.pendingEvents = [...events];
  }

  /**
   * Pending Event変更コールバックを設定
   */
  setOnPendingEventChange(callback: ((pending: PendingEventData[]) => void) | null): void {
    this.onPendingEventChange = callback;
  }

  /**
   * Pending Eventがあるかどうか
   */
  hasPendingEvents(): boolean {
    return this.pendingEvents.length > 0;
  }

  /**
   * Pending Eventsを処理してevents配列に追加
   * リロード後のPoSW計算復旧に使用
   * @returns 処理したイベント数
   */
  async processPendingEvents(): Promise<number> {
    if (this.pendingEvents.length === 0) {
      return 0;
    }

    console.log(`[TypingProof] Processing ${this.pendingEvents.length} pending events...`);

    // pendingEventsをコピーしてからクリア（処理中に新しいイベントが来ても安全に）
    const eventsToProcess = [...this.pendingEvents];
    this.pendingEvents = [];

    // タイムスタンプの単調増加を保証するため、最後のイベントのタイムスタンプを取得
    const lastEvent = this.events[this.events.length - 1];
    let lastTimestamp = lastEvent?.timestamp ?? -Infinity;
    const timestampMargin = 10; // 10ms のマージン

    let processedCount = 0;

    for (const pending of eventsToProcess) {
      try {
        // タイムスタンプを調整（最後のイベントより後になるように）
        // ページリロード後は pending.timestamp が古い値を持っている可能性があるため
        if (pending.timestamp <= lastTimestamp) {
          const newTimestamp = lastTimestamp + timestampMargin;
          console.log(`[TypingProof] Adjusting pending event timestamp: ${pending.timestamp.toFixed(2)} -> ${newTimestamp.toFixed(2)} (after last: ${lastTimestamp.toFixed(2)})`);
          pending.timestamp = newTimestamp;
        }

        // RecordEventInputを再構成
        const eventInput: RecordEventInput = {
          type: pending.input.type,
          inputType: pending.input.inputType,
          data: pending.input.data,
          rangeOffset: pending.input.rangeOffset,
          rangeLength: pending.input.rangeLength,
          range: pending.input.range,
          description: pending.input.description,
          isMultiLine: pending.input.isMultiLine,
          deletedLength: pending.input.deletedLength,
          insertedText: pending.input.insertedText,
          insertLength: pending.input.insertLength,
          deleteDirection: pending.input.deleteDirection,
          selectedText: pending.input.selectedText,
        };

        // _recordEventInternalを直接呼び出し（キューを通さない）
        await this._recordEventInternal(eventInput, pending);
        processedCount++;

        // 次のイベントのために lastTimestamp を更新
        lastTimestamp = pending.timestamp;
      } catch (error) {
        console.error('[TypingProof] Failed to process pending event:', error);
        // エラーが発生しても続行
      }
    }

    console.log(`[TypingProof] Processed ${processedCount}/${eventsToProcess.length} pending events`);
    return processedCount;
  }

  /**
   * シリアライズされた状態から新しいインスタンスを作成
   * @param state - シリアライズされた状態
   * @param fingerprintHash - フィンガープリントハッシュ
   * @param fingerprintComponents - フィンガープリント構成要素
   * @param externalWorker - 外部から提供されたWorker（symlinkedパッケージ対応）
   * @param processPending - Pending Eventsを処理するかどうか（デフォルト: true）
   */
  static async fromSerializedState(
    state: SerializedProofState,
    fingerprintHash: string,
    fingerprintComponents: FingerprintComponents,
    externalWorker?: Worker,
    processPending: boolean = true
  ): Promise<TypingProof> {
    const proof = new TypingProof();
    proof.fingerprint = fingerprintHash;
    proof.fingerprintComponents = fingerprintComponents;
    proof.restoreState(state);
    proof.initWorker(externalWorker);
    proof.initialized = true;

    // Pending Eventsがあれば処理
    if (processPending && proof.hasPendingEvents()) {
      await proof.processPendingEvents();
    }

    return proof;
  }
}
