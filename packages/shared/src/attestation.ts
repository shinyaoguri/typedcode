/**
 * AttestationService - Human attestation verification service
 *
 * Platform-agnostic service for verifying human attestations.
 * Uses fetch API which is available in both browser and Node.js 18+.
 */

import type { HumanAttestationEventData } from './types.js';

// ============================================================================
// 型定義
// ============================================================================

/** Human attestation data (legacy format from proof files) */
export interface HumanAttestation {
  verified: boolean;
  score: number;
  action: string;
  timestamp: string;
  hostname: string;
  signature: string;
}

/** Attestation verification result */
export interface AttestationVerificationResult {
  valid: boolean;
  message: string;
}

/** Attestation verification details (for create/export/legacy attestations) */
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
 * Human attestation verification service
 *
 * Calls Cloudflare Workers API endpoint to verify human attestations.
 */
export class AttestationService {
  private readonly apiUrl: string;

  constructor(apiUrl: string = 'https://typedcode-api.shinya-oguri.workers.dev') {
    this.apiUrl = apiUrl;
  }

  /**
   * Verify a human attestation on the server
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
      return { valid: false, message: 'Network error' };
    }
  }

  /**
   * Verify multiple attestations (create/export/legacy)
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

    // New format: both create and export attestations
    if (createAttestation && exportAttestation) {
      hasAttestation = true;
      createResult = await this.verify(createAttestation);
      exportResult = await this.verify(exportAttestation);
      allValid = createResult.valid && exportResult.valid;
    }
    // New format: create attestation only
    else if (createAttestation) {
      hasAttestation = true;
      createResult = await this.verify(createAttestation);
      allValid = createResult.valid;
    }
    // Legacy format: top-level humanAttestation
    else if (legacyAttestation) {
      hasAttestation = true;
      legacyResult = await this.verify(legacyAttestation);
      allValid = legacyResult.valid;
    }
    // No attestation (verification succeeds)
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
   * Format timestamp for display
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
