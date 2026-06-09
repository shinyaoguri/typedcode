/**
 * 監督コードの控え (教員用・学生に配布しない) を組み立てる純関数 (#80, ADR-0012)。
 *
 * AuthorPage から分離してあるのは、AuthorPage が Monaco を import する (= テストの node 環境で
 * `window` 未定義により読めない) ため。本モジュールは shared + i18n のみに依存し純粋に保つ。
 */

import type { CreatedExamPackage } from './examPackageAuthoring.js';
import { formatProctorTokenForDisplay } from './examPackageAuthoring.js';
import { t } from '../i18n/index.js';

/**
 * 控えのプレーンテキストを組み立てる。コードは平文 manifest に含まれず紛失すると復号不能なので、
 * 画面表示に加えて教員が durable に保存できるようにする。`now` は注入してテスト可能にする。
 */
export function buildProctorMemo(result: CreatedExamPackage, filename: string, now: Date): string {
  const m = result.manifest;
  return [
    t('author.memo.title'),
    '='.repeat(56),
    `${t('author.memo.generatedAt')}: ${now.toISOString()}`,
    '',
    `${t('author.result.proctorCodeLabel')}: ${formatProctorTokenForDisplay(result.proctorToken)}`,
    '',
    `${t('author.memo.problemFile')}: ${filename}`,
    `examId:      ${m.examId}`,
    `keyId:       ${m.keyId}`,
    `packageHash: ${result.packageHash}`,
    '',
    `- ${t('author.memo.note1')}`,
    `- ${t('author.memo.note2')}`,
    `- ${t('author.memo.note3')}`,
    '',
  ].join('\n');
}
