/**
 * VerificationEngine - 純粋な検証ロジック
 *
 * UIに依存しない検証ロジックを提供します。
 * verification.ts から抽出された純粋な関数群。
 */

import type {
  StoredEvent,
  HumanAttestationEventData,
  HashChainCheckpoint,
  SampledVerificationResult,
  PoswStats,
} from '@typedcode/shared';
import { TypingProof, calculatePoswStats } from '@typedcode/shared';
import type { ProofFile, HumanAttestation, VerificationResultData } from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/** メタデータ検証結果 */
export interface MetadataVerificationResult {
  valid: boolean;
  isPureTyping: boolean;
  message?: string;
}

/** ハッシュ鎖検証結果 */
export interface ChainVerificationResult {
  valid: boolean;
  message?: string;
  errorAt?: number;
  sampledResult?: SampledVerificationResult;
}

/** Attestation情報（抽出結果） */
export interface AttestationInfo {
  /** イベント#0からの作成時attestation */
  createAttestation: HumanAttestationEventData | null;
  /** preExportAttestationイベントからのエクスポート時attestation */
  exportAttestation: HumanAttestationEventData | null;
  /** 旧形式のトップレベルattestation */
  legacyAttestation: HumanAttestation | undefined;
}

/** 検証エンジン全体の結果 */
export interface VerificationEngineResult {
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  poswStats: PoswStats | undefined;
  sampledResult?: SampledVerificationResult;
  attestationInfo: AttestationInfo;
  message?: string;
  errorAt?: number;
}

/** チェーン検証の進捗コールバック（全件検証） */
export type ChainProgressCallback = (
  current: number,
  total: number,
  hashInfo?: { computed: string; expected: string; poswHash: string }
) => void;

/** チェーン検証の進捗コールバック（サンプリング検証） */
export type SampledProgressCallback = (
  phase: string,
  current: number,
  total: number,
  hashInfo?: { computed: string; expected: string; poswHash?: string }
) => void;

// ============================================================================
// VerificationEngine クラス
// ============================================================================

/**
 * 検証エンジン
 *
 * 証明データの検証を行う純粋なロジッククラス。
 * UIに依存せず、結果をデータとして返す。
 */
export class VerificationEngine {
  private typingProof: TypingProof;

  constructor() {
    this.typingProof = new TypingProof();
  }

  // ==========================================================================
  // Attestation抽出
  // ==========================================================================

  /**
   * イベントからHumanAttestationを抽出するヘルパー
   */
  private extractAttestationFromEvent(event: StoredEvent | undefined): HumanAttestationEventData | null {
    if (!event) return null;
    if (event.type !== 'humanAttestation' && event.type !== 'preExportAttestation') return null;

    const data = event.data;
    if (!data || typeof data !== 'object') return null;

    const attestation = data as HumanAttestationEventData;
    if (
      typeof attestation.verified !== 'boolean' ||
      typeof attestation.score !== 'number' ||
      typeof attestation.action !== 'string' ||
      typeof attestation.timestamp !== 'string' ||
      typeof attestation.hostname !== 'string' ||
      typeof attestation.signature !== 'string'
    ) {
      return null;
    }

    return attestation;
  }

  /**
   * イベント#0からHumanAttestationを抽出（作成時認証）
   */
  private extractAttestationFromFirstEvent(events: StoredEvent[]): HumanAttestationEventData | null {
    if (!events || events.length === 0) return null;
    const firstEvent = events[0];
    if (firstEvent?.type !== 'humanAttestation') return null;
    return this.extractAttestationFromEvent(firstEvent);
  }

  /**
   * preExportAttestationイベントを抽出（エクスポート前認証）
   */
  private extractPreExportAttestation(events: StoredEvent[]): HumanAttestationEventData | null {
    if (!events || events.length === 0) return null;
    // 最後のpreExportAttestationイベントを探す
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === 'preExportAttestation') {
        return this.extractAttestationFromEvent(event);
      }
    }
    return null;
  }

  /**
   * 証明データからattestation情報を抽出
   */
  extractAttestations(data: ProofFile): AttestationInfo {
    const events = data.proof?.events ?? [];
    return {
      createAttestation: this.extractAttestationFromFirstEvent(events),
      exportAttestation: this.extractPreExportAttestation(events),
      legacyAttestation: data.humanAttestation,
    };
  }

  // ==========================================================================
  // メタデータ検証
  // ==========================================================================

  /**
   * メタデータ整合性を検証
   *
   * 最終コードとメタデータが改竄されていないかを検証する。
   */
  async verifyMetadata(data: ProofFile): Promise<MetadataVerificationResult> {
    // content は空文字列を許可（初期化のみのファイル）
    const hasContent = data.content !== undefined && data.content !== null;
    if (!data.typingProofHash || !data.typingProofData || !hasContent) {
      return {
        valid: false,
        isPureTyping: false,
        message: 'メタデータが不完全です',
      };
    }

    try {
      const result = await this.typingProof.verifyTypingProofHash(
        data.typingProofHash,
        data.typingProofData,
        data.content
      );

      return {
        valid: result.valid,
        isPureTyping: result.isPureTyping ?? false,
        message: result.valid ? undefined : 'メタデータの整合性検証に失敗しました',
      };
    } catch (error) {
      return {
        valid: false,
        isPureTyping: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // ハッシュ鎖検証
  // ==========================================================================

  /**
   * ハッシュ鎖を検証（チェックポイントの有無で自動選択）
   */
  async verifyChain(
    data: ProofFile,
    onProgress?: ChainProgressCallback,
    onSampledProgress?: SampledProgressCallback
  ): Promise<ChainVerificationResult> {
    if (!data.proof?.events) {
      return {
        valid: false,
        message: 'イベントデータがありません',
      };
    }

    this.typingProof.events = data.proof.events;
    this.typingProof.currentHash = data.proof.finalHash;

    const hasCheckpoints = data.checkpoints && data.checkpoints.length > 0;

    if (hasCheckpoints) {
      return this.verifySampled(data.checkpoints!, onSampledProgress);
    } else {
      return this.verifyFull(onProgress);
    }
  }

  /**
   * 全件検証
   */
  private async verifyFull(onProgress?: ChainProgressCallback): Promise<ChainVerificationResult> {
    try {
      const result = await this.typingProof.verify(onProgress);
      return {
        valid: result.valid,
        message: result.message,
        errorAt: result.errorAt,
      };
    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * サンプリング検証
   */
  private async verifySampled(
    checkpoints: HashChainCheckpoint[],
    onProgress?: SampledProgressCallback
  ): Promise<ChainVerificationResult> {
    try {
      const result = await this.typingProof.verifySampled(checkpoints, 3, onProgress);
      return {
        valid: result.valid,
        message: result.message,
        errorAt: result.errorAt,
        sampledResult: result.sampledResult,
      };
    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // 統合検証
  // ==========================================================================

  /**
   * 証明データを完全に検証（メタデータ + ハッシュ鎖 + PoSW統計）
   *
   * 人間証明書の検証はAPI呼び出しが必要なため、このメソッドでは行わない。
   * AttestationServiceを使用すること。
   */
  async verify(
    data: ProofFile,
    options?: {
      onChainProgress?: ChainProgressCallback;
      onSampledProgress?: SampledProgressCallback;
    }
  ): Promise<VerificationEngineResult> {
    // 1. Attestation情報を抽出
    const attestationInfo = this.extractAttestations(data);

    // 2. メタデータ検証
    const metadataResult = await this.verifyMetadata(data);

    // 3. ハッシュ鎖検証
    const chainResult = await this.verifyChain(
      data,
      options?.onChainProgress,
      options?.onSampledProgress
    );

    // 4. PoSW統計計算（shared版を使用）
    const poswStats = data.proof?.events
      ? calculatePoswStats(data.proof.events)
      : undefined;

    return {
      metadataValid: metadataResult.valid,
      chainValid: chainResult.valid,
      isPureTyping: metadataResult.isPureTyping,
      poswStats,
      sampledResult: chainResult.sampledResult,
      attestationInfo,
      message: chainResult.message ?? metadataResult.message,
      errorAt: chainResult.errorAt,
    };
  }

  /**
   * VerificationResultData形式に変換（Worker互換）
   */
  toResultData(result: VerificationEngineResult): VerificationResultData {
    return {
      metadataValid: result.metadataValid,
      chainValid: result.chainValid,
      isPureTyping: result.isPureTyping,
      message: result.message,
      errorAt: result.errorAt,
      poswStats: result.poswStats,
      sampledResult: result.sampledResult,
    };
  }
}
