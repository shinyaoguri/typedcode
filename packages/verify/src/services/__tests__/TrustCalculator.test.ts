/**
 * TrustCalculator (#135) のテスト。
 *
 * 信頼バッジは verify (web) の security boundary の要 — 「タブは緑なのにバッジは failed」
 * 型の回帰 (#146) が着地する場所なので、error / warning / verified の軸を仕様として固定する。
 * VerificationController.handleComplete の status 判定はこれと同じ軸を見る (verify/CLAUDE.md)。
 */

import { describe, expect, it } from 'vitest';
import { TrustCalculator } from '../TrustCalculator.js';
import type { ScreenshotVerificationSummary, VerificationResultData } from '../../types.js';

/** 健全な anchored proof の検証結果 (テストごとに上書きして崩す)。 */
function healthyResult(): VerificationResultData {
  return {
    metadataValid: true,
    chainValid: true,
    isPureTyping: true,
    rootAnchored: true,
    signedCheckpointAnchored: true,
    signedCheckpointValid: true,
  } as unknown as VerificationResultData;
}

function noScreenshots(): ScreenshotVerificationSummary {
  return { total: 0, verified: 0, missing: 0, tampered: 0 };
}

function calc(
  result: VerificationResultData | null,
  screenshots: ScreenshotVerificationSummary = noScreenshots(),
  options?: { hasScreenShareOptOut?: boolean }
) {
  return TrustCalculator.calculate(result, undefined, screenshots, undefined, options);
}

describe('TrustCalculator.calculate — level determination', () => {
  it('reports verified when no issue is raised', () => {
    expect(calc(healthyResult()).level).toBe('verified');
  });

  it('fails when metadata verification failed', () => {
    const r = calc({ ...healthyResult(), metadataValid: false });
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'metadata' && i.severity === 'error')).toBe(true);
  });

  it('fails when the hash chain is broken', () => {
    expect(calc({ ...healthyResult(), chainValid: false }).level).toBe('failed');
  });

  it('fails when any screenshot is tampered', () => {
    const r = calc(healthyResult(), { total: 3, verified: 2, missing: 0, tampered: 1 });
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'screenshots' && i.severity === 'error')).toBe(true);
  });

  it('downgrades to partial (not failed) when screenshots are only missing', () => {
    const r = calc(healthyResult(), { total: 3, verified: 2, missing: 1, tampered: 0 });
    expect(r.level).toBe('partial');
  });

  it('fails when signed checkpoints exist but are invalid', () => {
    const r = calc({
      ...healthyResult(),
      signedCheckpointAnchored: true,
      signedCheckpointValid: false,
    });
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'anchoring' && i.severity === 'error')).toBe(true);
  });

  it('warns (partial) when no signed checkpoint anchors the proof', () => {
    const r = calc({ ...healthyResult(), signedCheckpointAnchored: false });
    expect(r.level).toBe('partial');
  });

  it('warns when the chain root is not server-anchored for a non-exam proof', () => {
    const r = calc({ ...healthyResult(), rootAnchored: false });
    expect(r.level).toBe('partial');
    expect(r.issues.some((i) => i.component === 'anchoring' && i.severity === 'warning')).toBe(true);
  });

  it('does not warn about root anchoring for an exam proof (own T0 binding)', () => {
    const r = calc({
      ...healthyResult(),
      rootAnchored: false,
      exam: { present: true, packageProvided: true, binding: { valid: true } },
    } as unknown as VerificationResultData);
    expect(r.issues.filter((i) => i.component === 'anchoring')).toHaveLength(0);
  });

  it('warns on non-pure typing', () => {
    const r = calc({ ...healthyResult(), isPureTyping: false });
    expect(r.level).toBe('partial');
    expect(r.issues.some((i) => i.component === 'typing')).toBe(true);
  });

  it('warns on screen-share opt-out', () => {
    const r = calc(healthyResult(), noScreenshots(), { hasScreenShareOptOut: true });
    expect(r.level).toBe('partial');
  });

  it('fails when a provided exam package fails binding verification', () => {
    const r = calc({
      ...healthyResult(),
      exam: { present: true, packageProvided: true, binding: { valid: false } },
    } as unknown as VerificationResultData);
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'exam' && i.severity === 'error')).toBe(true);
  });

  it('warns (unverified authenticity) for an exam proof without the package', () => {
    const r = calc({
      ...healthyResult(),
      exam: { present: true, packageProvided: false },
    } as unknown as VerificationResultData);
    expect(r.level).toBe('partial');
    expect(r.issues.some((i) => i.component === 'exam' && i.severity === 'warning')).toBe(true);
  });

  it('error always dominates warnings in the final level', () => {
    const r = calc(
      { ...healthyResult(), chainValid: false, isPureTyping: false, rootAnchored: false },
      { total: 1, verified: 0, missing: 1, tampered: 0 }
    );
    expect(r.level).toBe('failed');
  });
});
