/**
 * TrustCalculator (#135) のテスト。
 *
 * 信頼バッジは verify (web) の security boundary の要 — 「タブは緑なのにバッジは failed」
 * 型の回帰 (#146) が着地する場所なので、error / warning / verified の軸を仕様として固定する。
 * VerificationController.handleComplete の status 判定はこれと同じ軸を見る (verify/AGENTS.md)。
 */

import { describe, expect, it } from 'vitest';
import { TrustCalculator } from '../TrustCalculator.js';
import type { ContentMismatchInfo, ScreenshotVerificationSummary, VerificationResultData } from '../../types.js';
import { t } from '../../i18n/index.js';

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
  return TrustCalculator.calculate(result, screenshots, undefined, options);
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

  it('shows a localized chain issue, never the raw English worker message', () => {
    const r = calc({ ...healthyResult(), chainValid: false, message: 'Previous hash mismatch at event 42' });
    const chainIssue = r.issues.find((i) => i.component === 'chain');

    expect(chainIssue?.message).toBe(t('trust.issueChainInvalid'));
    expect(chainIssue?.message).not.toContain('Previous hash');
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

  describe('a session start token that cannot be verified (#329)', () => {
    /** 古い registry の検証器で新しい鍵の token を見た proof (root は自己整合、shared が valid:false に畳み済み)。 */
    const untrusted = (code: 'token-unknown-key' | 'token-invalid' | 'token-fingerprint-mismatch') =>
      ({
        ...healthyResult(),
        valid: false,
        rootAnchored: false,
        rootAnchorFailure: { code, reason: 'reason from shared', keyId: 'tcp-209901-future' },
      }) as VerificationResultData;

    it('fails with an anchoring error rather than a metadata error', () => {
      const r = calc(untrusted('token-unknown-key'));
      expect(r.level).toBe('failed');
      expect(r.issues.some((i) => i.component === 'anchoring' && i.severity === 'error')).toBe(true);
      expect(r.issues.some((i) => i.component === 'metadata')).toBe(false);
      expect(r.issues.some((i) => i.message === t('trust.issueMetadataInvalid'))).toBe(false);
    });

    it('does not also raise the root-not-anchored warning (the token exists; it is just untrusted)', () => {
      const r = calc(untrusted('token-unknown-key'));
      expect(r.issues.some((i) => i.message === t('trust.issueRootNotAnchored'))).toBe(false);
    });

    it('names the keyId and the outdated-registry hint only for an unknown key', () => {
      const unknownKey = calc(untrusted('token-unknown-key')).issues.find((i) => i.component === 'anchoring');
      const invalid = calc(untrusted('token-invalid')).issues.find((i) => i.component === 'anchoring');

      expect(unknownKey?.message).toBe(
        t('trust.issueSessionTokenUntrusted.unknownKey', { keyId: 'tcp-209901-future' })
      );
      expect(unknownKey?.message).toContain('tcp-209901-future');
      expect(invalid?.message).toBe(t('trust.issueSessionTokenUntrusted.invalid'));
    });

    it('uses a distinct message for a token issued for another device', () => {
      const r = calc(untrusted('token-fingerprint-mismatch'));
      const issue = r.issues.find((i) => i.component === 'anchoring' && i.severity === 'error');
      expect(issue?.message).toBe(t('trust.issueSessionTokenUntrusted.fingerprintMismatch'));
    });
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

  it('fails when a package was provided for a proof that has no exam block (#218)', () => {
    // ゲートの誤用。総合判定は invalid になるので、バッジ側も理由付きで failed に落ちる必要がある
    // (issue ゼロのまま level だけ落ちると、採点者は理由を辿れない)。
    const r = calc({
      ...healthyResult(),
      exam: { present: false, rootValid: false, packageProvided: true, binding: { valid: false } },
    } as unknown as VerificationResultData);
    expect(r.level).toBe('failed');
    expect(r.issues.some((i) => i.component === 'exam' && i.severity === 'error')).toBe(true);
  });

  // #223: proof.version のゲート。下限未満・不正形式は shared が valid:false にするので、バッジ側も
  // 理由つきで failed に落ちる必要がある。未知の新 major は reject せず warning。
  it.each(['tooOld', 'malformed'] as const)(
    'fails with a version issue when the proof version is %s (#223)',
    (versionStatus) => {
      const r = calc({ ...healthyResult(), valid: false, versionStatus });
      expect(r.level).toBe('failed');
      expect(r.issues.some((i) => i.component === 'version' && i.severity === 'error')).toBe(true);
    }
  );

  it('warns (partial, not failed) with the normalized version when the proof version is a newer major (#223)', () => {
    const r = calc({ ...healthyResult(), versionStatus: 'newer', declaredVersion: '2.0.0' });
    expect(r.level).toBe('partial');
    const issue = r.issues.find((i) => i.component === 'version');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('2.0.0');
  });

  it.each(['current', 'supported'] as const)(
    'raises no version issue for a %s proof version (#223)',
    (versionStatus) => {
      const r = calc({ ...healthyResult(), versionStatus });
      expect(r.level).toBe('verified');
      expect(r.issues.some((i) => i.component === 'version')).toBe(false);
    }
  );

  it('error always dominates warnings in the final level', () => {
    const r = calc(
      { ...healthyResult(), chainValid: false, isPureTyping: false, rootAnchored: false },
      { total: 1, verified: 0, missing: 1, tampered: 0, chainOnly: 0 }
    );
    expect(r.level).toBe('failed');
  });
});

describe('TrustCalculator.calculate — submission issues (#293)', () => {
  const info = (kind: ContentMismatchInfo['kind'], severity: ContentMismatchInfo['severity']): ContentMismatchInfo => ({
    filename: 'valid.js',
    additions: 1,
    deletions: 2,
    kind,
    severity,
  });

  it('fails when the bundled source differs from proof.content, as a source issue rather than a chain issue', () => {
    const r = TrustCalculator.calculate(healthyResult(), noScreenshots(), [info('mismatch', 'error')]);

    expect(r.level).toBe('failed');
    expect(r.issues.find((i) => i.component === 'source')).toMatchObject({ severity: 'error' });
    expect(r.issues.some((i) => i.component === 'chain')).toBe(false);
  });

  it('names the source file and the line counts in the mismatch message', () => {
    const r = TrustCalculator.calculate(healthyResult(), noScreenshots(), [info('mismatch', 'error')]);

    expect(r.issues.find((i) => i.component === 'source')?.message).toContain('valid.js');
  });

  it('only warns when the bundled source is missing', () => {
    const r = TrustCalculator.calculate(healthyResult(), noScreenshots(), [info('missing-source', 'warning')]);

    expect(r.level).toBe('partial');
    expect(r.issues.find((i) => i.component === 'source')).toMatchObject({ severity: 'warning' });
  });

  it('fails when the proof cannot be paired with a single source file', () => {
    const r = TrustCalculator.calculate(healthyResult(), noScreenshots(), [info('ambiguous', 'error')]);

    expect(r.level).toBe('failed');
  });
});
