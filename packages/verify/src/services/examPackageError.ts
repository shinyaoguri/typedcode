/**
 * 問題パッケージ (.tcexam) の取込を拒否した理由 → 表示する i18n キー (#223)。
 *
 * 「壊れている」と「この検証器より新しい形式」と「もう対応しない古い形式」を出し分ける。
 * 区別しないと、新しい形式のパッケージを渡された採点者が「壊れている」と読んで出題者へ問い合わせてしまう。
 * 判定そのもの (`parseExamPackageManifestResult`) は shared。ここは写像だけで DOM を持たない。
 */
import type { ExamManifestParseResult } from '@typedcode/shared';

export type ExamPackageErrorKey =
  | 'errors.examInvalidPackage'
  | 'errors.examPackageNewerFormat'
  | 'errors.examPackageUnsupportedFormat';

export function examPackageErrorKey(rejection: Extract<ExamManifestParseResult, { ok: false }>): ExamPackageErrorKey {
  if (rejection.code !== 'unsupportedFormatVersion') return 'errors.examInvalidPackage';
  return rejection.newer ? 'errors.examPackageNewerFormat' : 'errors.examPackageUnsupportedFormat';
}
