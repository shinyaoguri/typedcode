/**
 * `#0 humanAttestation` の組み立て (DOM 非依存の純関数)。
 *
 * - `attestationFromSessionToken`: session/start の token から #0 の監督印を作る (ADR-0017)。
 *   タブ作成時の認証 (`TabVerificationUI`) と、試験開始ゲート中の先行取得 (#236) の両方が使う
 * - `buildExamHumanAttestation`: 試験の #0。ゲート中に token が得られていれば verified の印、
 *   未解決・失敗なら合成 best-effort の印 (ADR-0006。解錠と編集開始はサーバを待たない)
 *
 * #0 の暗号的な束縛はここでは作らない: casual/class/assignment は proof 同梱の sessionStartToken、
 * exam は封印束縛 (initializeExam) が担う。ここで作るのはタイムライン上の可読な監査印で、
 * 検証器は `verified` を保証の導出に使わない。
 */

import type { HumanAttestationEventData, SessionStartToken } from '@typedcode/shared';
import type { VerificationResult } from '../../services/TurnstileService.js';

/** 試験開始ゲート中に Turnstile を先行取得するときの action (#236) */
export const EXAM_ATTESTATION_ACTION = 'exam_start';

/**
 * session/start の token から #0 の監督印を作る (ADR-0017)。signature は token 由来の印
 * (`session-start-token:<keyId>`) で、暗号的な検証には使わない。
 */
export function attestationFromSessionToken(
  result: VerificationResult,
  token: SessionStartToken,
  fallbackAction: string,
  fallbackHostname: string
): HumanAttestationEventData {
  return {
    verified: result.success,
    score: result.score ?? (result.success ? 1.0 : 0),
    action: token.payload.action ?? fallbackAction,
    timestamp: token.payload.issuedAt,
    hostname: token.payload.hostname ?? fallbackHostname,
    signature: `session-start-token:${token.keyId}`,
    success: result.success,
    failureReason: result.failureReason,
  };
}

/**
 * 試験の #0 humanAttestation を作る (#236)。
 *
 * @param result 試験開始ゲート中に先行取得した Turnstile + session/start の結果。解錠の瞬間に
 *   まだ決着していなければ `null` (待たない = ADR-0006 の「サーバを critical path に置かない」)
 * @param env hostname と、合成するときの時刻 (テストで固定できるよう注入する)
 * @returns token があれば verified の印。未解決なら従来の合成 attestation (verified=false /
 *   signature='unsigned')。失敗で決着していれば合成に失敗理由を添える
 */
export function buildExamHumanAttestation(
  result: VerificationResult | null,
  env: { hostname: string; now: Date }
): HumanAttestationEventData {
  if (result?.success && result.sessionToken) {
    return attestationFromSessionToken(result, result.sessionToken, EXAM_ATTESTATION_ACTION, env.hostname);
  }
  return {
    verified: false,
    score: 0,
    action: EXAM_ATTESTATION_ACTION,
    timestamp: env.now.toISOString(),
    hostname: env.hostname,
    signature: 'unsigned',
    success: false,
    ...(result?.failureReason ? { failureReason: result.failureReason } : {}),
  };
}
