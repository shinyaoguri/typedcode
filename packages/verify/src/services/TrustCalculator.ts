/**
 * TrustCalculator - 検証結果から信頼度を計算するサービス
 */
import type {
  TrustLevel,
  TrustIssue,
  TrustResult,
  TrustIssueComponent,
  VerificationResultData,
  ScreenshotVerificationSummary,
} from '../types';

export interface AttestationResult {
  createValid?: boolean;
  exportValid?: boolean;
  hasAttestation: boolean;
}

export class TrustCalculator {
  /**
   * 検証結果から信頼度を計算
   */
  static calculate(
    verificationResult: VerificationResultData | null,
    attestationResult: AttestationResult | undefined,
    screenshots: ScreenshotVerificationSummary
  ): TrustResult {
    const issues: TrustIssue[] = [];

    // 1. メタデータ検証
    if (verificationResult && !verificationResult.metadataValid) {
      issues.push({
        component: 'metadata',
        severity: 'error',
        message: 'メタデータ検証失敗',
      });
    }

    // 2. ハッシュチェーン検証
    if (verificationResult && !verificationResult.chainValid) {
      issues.push({
        component: 'chain',
        severity: 'error',
        message: verificationResult.message || 'ハッシュチェーン検証失敗',
      });
    }

    // 3. スクリーンショット検証
    if (screenshots.tampered > 0) {
      issues.push({
        component: 'screenshots',
        severity: 'error',
        message: `${screenshots.tampered}枚に改竄の可能性`,
      });
    }
    if (screenshots.missing > 0) {
      issues.push({
        component: 'screenshots',
        severity: 'warning',
        message: `${screenshots.missing}枚が欠損`,
      });
    }

    // 4. Attestation検証（ネットワークエラーなどは警告扱い）
    if (attestationResult?.hasAttestation) {
      const createFailed = attestationResult.createValid === false;
      const exportFailed = attestationResult.exportValid === false;

      if (createFailed && exportFailed) {
        issues.push({
          component: 'attestation',
          severity: 'warning',
          message: '人間証明の検証に失敗',
        });
      } else if (createFailed) {
        issues.push({
          component: 'attestation',
          severity: 'warning',
          message: '作成時の人間証明が無効',
        });
      } else if (exportFailed) {
        issues.push({
          component: 'attestation',
          severity: 'warning',
          message: 'エクスポート時の人間証明が無効',
        });
      }
    }

    // レベル判定
    const level = this.determineLevel(issues);
    const summary = this.generateSummary(level, issues);

    return { level, summary, issues };
  }

  /**
   * 問題リストから信頼度レベルを判定
   */
  private static determineLevel(issues: TrustIssue[]): TrustLevel {
    const hasError = issues.some((i) => i.severity === 'error');
    const hasWarning = issues.some((i) => i.severity === 'warning');

    if (hasError) return 'failed';
    if (hasWarning) return 'partial';
    return 'verified';
  }

  /**
   * 信頼度レベルに応じたサマリーを生成
   */
  private static generateSummary(level: TrustLevel, issues: TrustIssue[]): string {
    switch (level) {
      case 'verified':
        return '検証成功';
      case 'partial': {
        const warningCount = issues.filter((i) => i.severity === 'warning').length;
        return `警告あり（${warningCount}件）`;
      }
      case 'failed': {
        const errorCount = issues.filter((i) => i.severity === 'error').length;
        return `検証失敗（${errorCount}件のエラー）`;
      }
    }
  }

  /**
   * コンポーネント別に問題を取得
   */
  static getIssuesByComponent(
    issues: TrustIssue[],
    component: TrustIssueComponent
  ): TrustIssue[] {
    return issues.filter((i) => i.component === component);
  }

  /**
   * 空のスクリーンショットサマリーを生成
   */
  static emptyScreenshotSummary(): ScreenshotVerificationSummary {
    return { total: 0, verified: 0, missing: 0, tampered: 0 };
  }
}
