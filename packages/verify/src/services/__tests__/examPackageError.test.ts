/**
 * 問題パッケージの取込拒否 → 表示キー (#223)。
 *
 * 「壊れている」「より新しい形式」「もう対応しない古い形式」を取り違えると、採点者が新しい検証器を
 * 使う代わりに出題者へ「壊れている」と問い合わせる。入力は shared の `parseExamPackageManifestResult` の
 * 実物の結果で与える (写像だけを固定し、拒否の判定自体は shared のテストの担当)。
 */

import { describe, expect, it } from 'vitest';
import { parseExamPackageManifestResult } from '@typedcode/shared';
import { examPackageErrorKey } from '../examPackageError.js';
import { t } from '../../i18n/index.js';

function rejection(input: unknown) {
  const r = parseExamPackageManifestResult(input);
  if (r.ok) throw new Error('expected a rejection');
  return r;
}

describe('examPackageErrorKey', () => {
  it('maps a newer formatVersion to the "use an up-to-date verifier" message', () => {
    expect(examPackageErrorKey(rejection({ formatVersion: 2 }))).toBe('errors.examPackageNewerFormat');
  });

  it('maps an older formatVersion to the "ask for a new package" message', () => {
    expect(examPackageErrorKey(rejection({ formatVersion: 0 }))).toBe('errors.examPackageUnsupportedFormat');
  });

  it('maps a malformed manifest to the generic invalid-package message', () => {
    expect(examPackageErrorKey(rejection({ formatVersion: 1 }))).toBe('errors.examInvalidPackage');
    expect(examPackageErrorKey(rejection('not an object'))).toBe('errors.examInvalidPackage');
  });

  it('has a distinct, translated message for each reason', () => {
    const messages = new Set(
      (
        ['errors.examInvalidPackage', 'errors.examPackageNewerFormat', 'errors.examPackageUnsupportedFormat'] as const
      ).map((key) => t(key))
    );
    expect(messages.size).toBe(3);
  });
});
