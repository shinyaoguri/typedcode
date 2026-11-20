/**
 * 仕様別の検証の入口 (#809 / ADR-0053)。
 *
 * 1. 入力を識別し、静的な registry から検証器を 1 つだけ選ぶ (`identify.ts`)
 * 2. `supported` ならその仕様の検証器を原本に適用する。`unsupported` / `malformed` なら**どの検証器も呼ばない**
 *    (未知の版を 1.2.0 の規則で読まない。検証に失敗しても別の版で試し直さない)
 * 3. 結果を共通の結果 (`types.ts`) に写し、信頼の識別と評価時刻を残す
 *
 * 隠れた入力を持たない: 時計 (`Date.now()`・引数なしの `new Date()`・`performance.now()`) もネットワーク
 * (`fetch`) も使わない。信頼する鍵と評価時刻は `context` で必ず受け取り、既定の registry に黙って落とさない。
 * 同じ入力・同じ信頼・同じ方針・同じ評価時刻なら同じ結果を返す。
 *
 * 公式 Web / CLI はまだ `verifyProofFile` を直接使う。切り替えは #811。
 */

import { normalizeAcceptancePolicy, type AcceptancePolicyResult } from '../acceptancePolicy.js';
import { computeHash, deterministicStringify } from '../utils/hashUtils.js';
import type { ProofFile } from '../verification.js';
import { identifyProofSpec } from './identify.js';
import { verifyLegacyTypingProof } from './legacyTypingProof.js';
import {
  SPEC_RESULT_SCHEMA,
  type SpecChecks,
  type SpecTrustResult,
  type SpecVerificationContext,
  type SpecVerificationResult,
} from './types.js';

const NOT_CHECKED_CHECKS: SpecChecks = {
  structure: { status: 'not-checked' },
  metadata: { status: 'not-checked' },
  root: { status: 'not-checked' },
  chain: { status: 'not-checked' },
  posw: { status: 'not-checked' },
  finalHash: { status: 'not-checked' },
  content: { status: 'not-checked' },
  checkpoints: { status: 'not-checked' },
  signedCheckpoints: { status: 'not-checked' },
  sessionAnchor: { status: 'not-checked' },
  problemBinding: { status: 'not-checked' },
};

/** `context` の必須の値を確かめる。欠けていれば既定に落とさず throw する (呼び出し側の誤り) */
function assertContext(context: SpecVerificationContext): void {
  const trust = context?.trust;
  if (!trust || !Array.isArray(trust.checkpointKeys) || !Array.isArray(trust.examAuthorityKeys)) {
    throw new TypeError('verifyProofBySpec: context.trust.checkpointKeys and examAuthorityKeys are required');
  }
  if (typeof context.evaluationTime !== 'string' || !Number.isFinite(Date.parse(context.evaluationTime))) {
    throw new TypeError('verifyProofBySpec: context.evaluationTime must be an ISO 8601 date string');
  }
}

/** 信頼に使った鍵一覧の識別。鍵一覧が 1 つでも違えば digest も変わる */
async function trustSnapshot(context: SpecVerificationContext): Promise<SpecTrustResult['snapshot']> {
  const digest = await computeHash(
    deterministicStringify({
      checkpointKeys: context.trust.checkpointKeys,
      examAuthorityKeys: context.trust.examAuthorityKeys,
    })
  );
  return context.trust.label === undefined ? { digest } : { label: context.trust.label, digest };
}

/**
 * proof を、その版の仕様の検証器で検証する。
 *
 * `context.trust` と `context.evaluationTime` は必須。`evaluationTime` は結果に写すだけで、legacy 1.2.0 の
 * 規則は評価時刻を判定に使わない (鍵の有効期間は証拠側の時刻で判定する。system-spec §6.5)。
 */
export async function verifyProofBySpec(
  input: unknown,
  context: SpecVerificationContext
): Promise<SpecVerificationResult> {
  assertContext(context);
  const mode = context.mode ?? 'full';
  const support = identifyProofSpec(input);
  const snapshot = await trustSnapshot(context);
  const evaluation = { time: context.evaluationTime, mode };

  if (support.status !== 'supported') {
    const acceptance: AcceptancePolicyResult = {
      applied: normalizeAcceptancePolicy(context.policy ?? {}),
      evaluated: false,
      violations: [],
    };
    return {
      resultSchema: SPEC_RESULT_SCHEMA,
      support,
      integrity: 'not-evaluated',
      checks: NOT_CHECKED_CHECKS,
      limitations: [],
      trust: { snapshot, keys: [] },
      acceptance,
      evaluation,
    };
  }

  // 登録済みの仕様は legacy 1.2.0 だけ (support.spec === 'legacy-typing-proof@1.2.0')。仕様を足したら
  // ここで support.spec ごとに検証器を選ぶ
  const outcome = await verifyLegacyTypingProof(input as ProofFile, { ...context, mode });
  const detail: SpecVerificationResult['detail'] = { legacyProof: outcome.legacyProof };
  if (outcome.examBinding) detail.examBinding = outcome.examBinding;
  return {
    resultSchema: SPEC_RESULT_SCHEMA,
    support,
    integrity: outcome.integrity,
    checks: outcome.checks,
    limitations: outcome.limitations,
    trust: { snapshot, keys: outcome.keys },
    acceptance: outcome.acceptance,
    evaluation,
    detail,
  };
}
