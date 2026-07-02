/**
 * TrustCalculator - 検証結果から信頼度を計算するサービス
 *
 * 注意: メインスレッド専用 (TabController から呼ばれる)。
 * t() を使うため Web Worker 内では使用しないこと。
 */
import { t } from '../i18n/index';
import type {
  TrustLevel,
  TrustIssue,
  TrustResult,
  TrustIssueComponent,
  VerificationResultData,
  ScreenshotVerificationSummary,
  ContentMismatchInfo,
} from '../types';

export interface AttestationResult {
  createValid?: boolean;
  exportValid?: boolean;
  hasAttestation: boolean;
}

export interface TrustCalculatorOptions {
  /** 画面共有をオプトアウトしたかどうか */
  hasScreenShareOptOut?: boolean;
}

export class TrustCalculator {
  /**
   * 検証結果から信頼度を計算
   * @param verificationResult - 検証結果
   * @param attestationResult - 人間証明結果
   * @param screenshots - スクリーンショット検証サマリー
   * @param contentMismatches - ソースファイル不一致情報（オプション）
   * @param options - 追加オプション
   */
  static calculate(
    verificationResult: VerificationResultData | null,
    attestationResult: AttestationResult | undefined,
    screenshots: ScreenshotVerificationSummary,
    contentMismatches?: ContentMismatchInfo[],
    options?: TrustCalculatorOptions
  ): TrustResult {
    const issues: TrustIssue[] = [];

    // 1. メタデータ検証
    if (verificationResult && !verificationResult.metadataValid) {
      issues.push({
        component: 'metadata',
        severity: 'error',
        message: t('trust.issueMetadataInvalid'),
      });
    }

    // 2. ハッシュチェーン検証
    if (verificationResult && !verificationResult.chainValid) {
      issues.push({
        component: 'chain',
        severity: 'error',
        message: verificationResult.message || t('trust.issueChainInvalid'),
      });
    }

    // 3. スクリーンショット検証
    if (screenshots.tampered > 0) {
      issues.push({
        component: 'screenshots',
        severity: 'error',
        message: t('trust.issueScreenshotsTampered', { count: screenshots.tampered }),
      });
    }
    if (screenshots.missing > 0) {
      issues.push({
        component: 'screenshots',
        severity: 'warning',
        message: t('trust.issueScreenshotsMissing', { count: screenshots.missing }),
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
          message: t('trust.issueAttestationBoth'),
        });
      } else if (createFailed) {
        issues.push({
          component: 'attestation',
          severity: 'warning',
          message: t('trust.issueAttestationCreate'),
        });
      } else if (exportFailed) {
        issues.push({
          component: 'attestation',
          severity: 'warning',
          message: t('trust.issueAttestationExport'),
        });
      }
    }

    // 5. ソースファイル不一致検証
    if (contentMismatches && contentMismatches.length > 0) {
      for (const mismatch of contentMismatches) {
        issues.push({
          component: 'source',
          severity: 'warning',
          message: t('trust.issueSourceMismatch', {
            filename: mismatch.filename,
            additions: mismatch.additions,
            deletions: mismatch.deletions,
          }),
        });
      }
    }

    // 6. 画面共有オプトアウト検証
    if (options?.hasScreenShareOptOut) {
      issues.push({
        component: 'screenshots',
        severity: 'warning',
        message: t('trust.screenShareOptOut'),
      });
    }

    // 7. 時刻アンカー（署名チェックポイント）— サーバ署名による唯一の偽造不能要素。
    //    無ければ proof は完全オフライン捏造が可能なので警告として明示する。
    if (verificationResult) {
      if (
        verificationResult.signedCheckpointAnchored &&
        verificationResult.signedCheckpointValid === false
      ) {
        issues.push({
          component: 'anchoring',
          severity: 'error',
          message: t('trust.issueAnchoringInvalid'),
        });
      } else if (!verificationResult.signedCheckpointAnchored) {
        issues.push({
          component: 'anchoring',
          severity: 'warning',
          message: t('trust.issueAnchoringMissing'),
        });
      } else {
        // anchored かつ valid。補助的な疑い指標（post-hoc / 密度）は併存しうるので個別に積む。
        if (verificationResult.signedCheckpointTemporal?.postHocSuspected) {
          issues.push({
            component: 'anchoring',
            severity: 'warning',
            message: t('trust.issueAnchoringPostHoc'),
          });
        }
        // ADR-0016: 署名 cp が主張イベント数/時間に対して疎（末尾 1 個で長い鎖をアンカー等）。
        if (verificationResult.signedCheckpointDensity?.sparse) {
          issues.push({
            component: 'anchoring',
            severity: 'warning',
            message: t('trust.issueAnchoringSparse'),
          });
        }
      }
    }

    // 7.5 root のサーバアンカー（ADR-0017）。serverNonce 付きトークンで root がアンカーされていない
    //     (= 完全オフライン捏造の余地) なら警告。exam は独自の T0 束縛を持つため対象外。
    if (
      verificationResult &&
      verificationResult.metadataValid &&
      !verificationResult.rootAnchored &&
      !verificationResult.exam?.present
    ) {
      issues.push({
        component: 'anchoring',
        severity: 'warning',
        message: t('trust.issueRootNotAnchored'),
      });
    }

    // 8. ピュアタイピング（ペースト/バルク挿入の有無）
    if (verificationResult && !verificationResult.isPureTyping) {
      issues.push({
        component: 'typing',
        severity: 'warning',
        message: t('trust.issueNotPureTyping'),
      });
    }

    // 9. 試験束縛（ADR-0006）。package 提供下で失敗なら error、未提供なら真正性未確認の警告。
    if (verificationResult?.exam?.present) {
      if (
        verificationResult.exam.packageProvided &&
        verificationResult.exam.binding?.valid === false
      ) {
        issues.push({
          component: 'exam',
          severity: 'error',
          message: t('trust.issueExamBindingFailed'),
        });
      } else if (!verificationResult.exam.packageProvided) {
        issues.push({
          component: 'exam',
          severity: 'warning',
          message: t('trust.issueExamUnverified'),
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
        return t('trust.summaryVerified');
      case 'partial': {
        const warningCount = issues.filter((i) => i.severity === 'warning').length;
        return t('trust.summaryPartial', { count: warningCount });
      }
      case 'failed': {
        const errorCount = issues.filter((i) => i.severity === 'error').length;
        return t('trust.summaryFailed', { count: errorCount });
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
