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

    // 5. ソースファイル不一致検証
    if (contentMismatches && contentMismatches.length > 0) {
      for (const mismatch of contentMismatches) {
        issues.push({
          component: 'source',
          severity: 'warning',
          message: `${mismatch.filename}: ソースファイルと証明内容が異なります (+${mismatch.additions}/-${mismatch.deletions}行)`,
        });
      }
    }

    // 6. 画面共有オプトアウト検証
    if (options?.hasScreenShareOptOut) {
      issues.push({
        component: 'screenshots',
        severity: 'warning',
        message: '画面共有なしモードで記録されました',
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
          message: '署名チェックポイントが無効です',
        });
      } else if (!verificationResult.signedCheckpointAnchored) {
        issues.push({
          component: 'anchoring',
          severity: 'warning',
          message: '時刻アンカー（署名チェックポイント）がありません',
        });
      } else {
        // anchored かつ valid。補助的な疑い指標（post-hoc / 密度）は併存しうるので個別に積む。
        if (verificationResult.signedCheckpointTemporal?.postHocSuspected) {
          issues.push({
            component: 'anchoring',
            severity: 'warning',
            message: 'post-hoc 一括署名の疑いがあります（サーバ時刻が申告時間より極端に短い）',
          });
        }
        // ADR-0016: 署名 cp が主張イベント数/時間に対して疎（末尾 1 個で長い鎖をアンカー等）。
        if (verificationResult.signedCheckpointDensity?.sparse) {
          issues.push({
            component: 'anchoring',
            severity: 'warning',
            message: 'アンカー密度が疎です（署名チェックポイントが申告セッションに対し少ない/遅い）',
          });
        }
      }
    }

    // 8. ピュアタイピング（ペースト/バルク挿入の有無）
    if (verificationResult && !verificationResult.isPureTyping) {
      issues.push({
        component: 'typing',
        severity: 'warning',
        message: 'ピュアタイピングではありません（ペースト/バルク挿入あり）',
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
          message: '問題束縛（署名/内容ハッシュ）の検証に失敗しました',
        });
      } else if (!verificationResult.exam.packageProvided) {
        issues.push({
          component: 'exam',
          severity: 'warning',
          message: '問題パッケージ未読込のため真正性は未確認です',
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
