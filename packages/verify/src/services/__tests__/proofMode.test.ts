/**
 * proof.json の自己申告モード (ADR-0011) の allowlist 検証のテスト。
 *
 * `ExportedProof.mode` は型の上では union だが実体は `JSON.parse` の結果なので、
 * 実行時は任意の文字列が入りうる (#210)。表示層へ届く前にここで落とすことを固定する。
 */

import { describe, expect, it } from 'vitest';
import { PROOF_MODES, normalizeProofMode } from '../proofMode.js';

describe('normalizeProofMode', () => {
  it.each(PROOF_MODES)('accepts the known mode %s', (mode) => {
    expect(normalizeProofMode(mode)).toBe(mode);
  });

  it('rejects a mode carrying an HTML payload', () => {
    expect(normalizeProofMode('<img src=x onerror=alert(1)>')).toBeUndefined();
  });

  it('rejects an unknown mode label', () => {
    expect(normalizeProofMode('Exam')).toBeUndefined();
  });

  it('rejects non-string values', () => {
    expect(normalizeProofMode(undefined)).toBeUndefined();
    expect(normalizeProofMode(null)).toBeUndefined();
    expect(normalizeProofMode(42)).toBeUndefined();
    expect(normalizeProofMode({ toString: () => 'exam' })).toBeUndefined();
  });
});
