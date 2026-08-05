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
    valid: true,
    metadataValid: true,
    chainValid: true,
    isPureTyping: true,
    rootAnchored: true,
    signedCheckpointAnchored: true,
    signedCheckpointValid: true,
  } as unknown as VerificationResultData;
}

function noScreenshots(): ScreenshotVerificationSummary {
  return { total: 0, verified: 0, missing: 0, tampered: 0, chainOnly: 0 };
}

function calc(
  result: VerificationResultData | null,
  screenshots: ScreenshotVerificationSummary | undefined = noScreenshots(),
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
    const r = calc(healthyResult(), { total: 3, verified: 2, missing: 0, tampered: 1, chainOnly: 0 });
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'screenshots' && i.severity === 'error')).toBe(true);
  });

  it('downgrades to partial (not failed) when screenshots are only missing', () => {
    const r = calc(healthyResult(), { total: 3, verified: 2, missing: 1, tampered: 0, chainOnly: 0 });
    expect(r.level).toBe('partial');
  });

  it('warns when the chain records screenshots that the manifest does not list (stripped)', () => {
    const r = calc(healthyResult(), { total: 0, verified: 0, missing: 0, tampered: 0, chainOnly: 2 });
    expect(r.level).toBe('partial');
    expect(r.issues.some((i) => i.component === 'screenshots' && i.severity === 'warning')).toBe(true);
  });

  it('raises no screenshot issue when screenshots were never checked (proof.json only)', () => {
    const r = calc(healthyResult(), undefined);
    expect(r.level).toBe('verified');
    expect(r.issues.some((i) => i.component === 'screenshots')).toBe(false);
  });

  // #214: fast モードは PoSW の反復再計算をスキップする。issue を積まないと 0 件 = 「検証成功」に
  // なり、採点者が「10,000 回の逐次作業まで検証済み」と読み違える (spec §8.2 との overclaim)。
  it('warns (partial) when PoSW was not recomputed (fast mode)', () => {
    const r = calc({ ...healthyResult(), verificationMode: 'fast', poswMode: 'skipped' });
    expect(r.level).toBe('partial');
    expect(r.issues.some((i) => i.component === 'posw' && i.severity === 'warning')).toBe(true);
  });

  it('raises no PoSW issue when the PoSW was actually recomputed (full mode)', () => {
    const r = calc({ ...healthyResult(), verificationMode: 'full', poswMode: 'full' });
    expect(r.level).toBe('verified');
    expect(r.issues.some((i) => i.component === 'posw')).toBe(false);
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

  it('attributes an invalid signed checkpoint to anchoring, never to the hash chain (#211)', () => {
    // 委譲前は worker が chainValid に署名 cp を畳み込んでいたため「ハッシュチェーン: <anchoring の理由>」
    // という誤帰属が出ていた。整合性 (chain) と時刻アンカーは別層 (ADR-0020)。
    const r = calc({
      ...healthyResult(),
      valid: false,
      chainValid: true,
      signedCheckpointAnchored: true,
      signedCheckpointValid: false,
    });
    expect(r.issues.some((i) => i.component === 'chain')).toBe(false);
    expect(r.issues.some((i) => i.component === 'anchoring' && i.severity === 'error')).toBe(true);
  });

  it('fails when the session start token does not match the signed checkpoint session (#211)', () => {
    // 別セッションのトークン流用 (spec §6.3)。CLI は invalid とするので web も緑にしない。
    const r = calc({ ...healthyResult(), valid: false, sessionTokenMismatch: true });
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'anchoring' && i.severity === 'error')).toBe(true);
    // 暗号的な改ざんではないので整合性 (chain) の error にはしない。
    expect(r.issues.some((i) => i.component === 'chain')).toBe(false);
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
      { total: 1, verified: 0, missing: 1, tampered: 0, chainOnly: 0 }
    );
    expect(r.level).toBe('failed');
  });
});
