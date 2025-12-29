/**
 * AttestationService - 人間証明書検証サービス
 *
 * 人間証明書のAPI検証を行うサービスクラス。
 * verification.ts から抽出。
 */

import type { HumanAttestationEventData } from '@typedcode/shared';
import type { HumanAttestation } from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/** Attestation検証結果 */
export interface AttestationVerificationResult {
  valid: boolean;
  message: string;
}

/** Attestation検証の詳細結果（作成時・エクスポート時の両方） */
export interface AttestationVerificationDetails {
  createResult: AttestationVerificationResult | null;
  exportResult: AttestationVerificationResult | null;
  legacyResult: AttestationVerificationResult | null;
  allValid: boolean;
  hasAttestation: boolean;
}

// ============================================================================
// AttestationService クラス
// ============================================================================

/**
 * 人間証明書検証サービス
 *
 * Cloudflare Workers上のAPIを呼び出して人間証明書を検証する。
 */
export class AttestationService {
  private readonly apiUrl: string;

  constructor(apiUrl: string = 'https://typedcode-api.shinya-oguri.workers.dev') {
    this.apiUrl = apiUrl;
  }

  /**
   * 人間証明書をサーバーで検証
   */
  async verify(attestation: HumanAttestation | HumanAttestationEventData): Promise<AttestationVerificationResult> {
    try {
      const response = await fetch(`${this.apiUrl}/api/verify-attestation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attestation }),
      });

      if (!response.ok) {
        return { valid: false, message: `HTTP ${response.status}` };
      }

      const result = await response.json() as { valid: boolean; message: string };
      return result;
    } catch (error) {
      console.error('[AttestationService] Verification failed:', error);
      return { valid: false, message: 'ネットワークエラー' };
    }
  }

  /**
   * 複数のattestationを検証（作成時・エクスポート時・旧形式）
   */
  async verifyAll(
    createAttestation: HumanAttestationEventData | null,
    exportAttestation: HumanAttestationEventData | null,
    legacyAttestation: HumanAttestation | undefined
  ): Promise<AttestationVerificationDetails> {
    let createResult: AttestationVerificationResult | null = null;
    let exportResult: AttestationVerificationResult | null = null;
    let legacyResult: AttestationVerificationResult | null = null;
    let allValid = true;
    let hasAttestation = false;

    // 新形式: 作成時 + エクスポート時の両方がある場合
    if (createAttestation && exportAttestation) {
      hasAttestation = true;
      createResult = await this.verify(createAttestation);
      exportResult = await this.verify(exportAttestation);
      allValid = createResult.valid && exportResult.valid;
    }
    // 新形式: 作成時のみ
    else if (createAttestation) {
      hasAttestation = true;
      createResult = await this.verify(createAttestation);
      allValid = createResult.valid;
    }
    // 旧形式: トップレベルのhumanAttestation
    else if (legacyAttestation) {
      hasAttestation = true;
      legacyResult = await this.verify(legacyAttestation);
      allValid = legacyResult.valid;
    }
    // 証明書なし（検証は成功扱い）
    else {
      allValid = true;
      hasAttestation = false;
    }

    return {
      createResult,
      exportResult,
      legacyResult,
      allValid,
      hasAttestation,
    };
  }

  /**
   * タイムスタンプをフォーマット
   */
  formatTimestamp(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return timestamp;
      return date.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return timestamp;
    }
  }
}
