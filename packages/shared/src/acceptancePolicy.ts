/**
 * 受理ポリシー (#296 / ADR-0043)
 *
 * 「proof は改ざんされていないか」(整合性) と「この proof を採点で受理するか」(受理ポリシー) を
 * 分けて返すためのモジュール。整合性の判定は `verifyProofFile` が持ち、ここは整合性を通った proof に
 * 対して、採点者が opt-in で足す要件を**判定の材料 (検証済みの値) だけから**評価する純関数を持つ。
 *
 * - ADR-0016 (密度) / ADR-0017 (root アンカー) の gate を一般化したもの。かつて密度 gate は
 *   `verifySignedCheckpoints` の `valid` を落としており、「改ざん」と「証拠が足りない」を機械的に
 *   見分けられなかった
 * - 違反は `valid` / `errorMessage` に畳まず `violations` に code つきで残す
 * - 整合性が落ちた proof ではポリシーを評価しない (改ざん proof の値で「末尾が何件未署名」を語らない)。
 *   評価したかどうかは `AcceptancePolicyResult.evaluated` で分ける (#301 と同じ考え方)
 * - time-box と LMS の受領時刻は入れない (ADR-0013)。自己申告の `proof.mode` も入力に使わない (ADR-0020)
 */

import type { SignedCheckpointsVerificationResult } from './types.js';

/** 採点者が opt-in で足す受理要件。既定はすべて false (= 整合性だけで受理する)。 */
export interface AcceptancePolicy {
  /**
   * root がサーバアンカーされていること (ADR-0017。verify-cli の `--require-root-anchor`)。
   * exam proof の免除は束縛が検証済み (`examBindingVerified`) のときだけ (#131)。
   */
  requireRootAnchor?: boolean;
  /**
   * 署名 cp が主張したイベント数 / 時間に対して疎でないこと (ADR-0016。`--require-anchor-density`)。
   * 署名 cp が 0 件の proof は `density: null` で**対象外** (存在を求めるのは `requireSignedCheckpoints`)。
   */
  requireAnchorDensity?: boolean;
  /** 署名 cp が 1 件以上あること (`--require-signed-checkpoints`)。 */
  requireSignedCheckpoints?: boolean;
  /**
   * 最後の署名 cp が最終イベントを指していること (`--require-final-anchor`)。署名 cp が 0 件なら
   * 全イベントが未署名の末尾として数える。イベントが 0 件の proof は対象外 (署名すべき末尾が無い)。
   */
  requireTerminalAnchor?: boolean;
}

export type AcceptancePolicyViolationCode =
  | 'root-anchor-missing'
  | 'anchor-density-sparse'
  | 'signed-checkpoints-missing'
  | 'terminal-anchor-missing';

export interface AcceptancePolicyViolation {
  code: AcceptancePolicyViolationCode;
  /** 固定の英文 (proof 由来の値を含まない)。verify-cli は `Error:` 行と Policy 節に出す。 */
  message: string;
  /** `terminal-anchor-missing` のときだけ: 最後の署名 cp より後のイベント数 (未署名の末尾)。 */
  unsignedTailEvents?: number;
}

export interface AcceptancePolicyResult {
  /** 適用した要件。立てなかったものも false で残す (何を求めたかを結果だけから読めるように)。 */
  applied: Required<AcceptancePolicy>;
  /**
   * ポリシーを評価したか。整合性 (`integrityValid`) が落ちた proof では評価せず false で、
   * そのとき `violations` は空。「違反なし」と「評価していない」をこのフラグで分ける。
   */
  evaluated: boolean;
  violations: AcceptancePolicyViolation[];
}

/** ポリシーの評価に使う、検証済みの値だけを集めた入力。 */
export interface AcceptancePolicyEvidence {
  /** root が検証済みの token でサーバアンカーされたか (`FullVerificationResult.rootAnchored`)。 */
  rootAnchored: boolean;
  /** exam proof で、束縛が実際に検証済み (#131)。root アンカー要件を免除する唯一の条件。 */
  examExempt: boolean;
  /** proof に exam ブロックがあるか。root アンカー違反の文言を出し分けるためだけに使う。 */
  isExam: boolean;
  signedCheckpoints: Pick<SignedCheckpointsVerificationResult, 'coverage' | 'density'>;
}

export const ROOT_ANCHOR_REQUIRED_MESSAGE = 'Root is not server-anchored (ADR-0017) but root anchoring is required';
export const EXAM_ROOT_ANCHOR_REQUIRED_MESSAGE =
  'Root anchoring is required and the exam binding is not verified (provide and verify the exam package to exempt an exam proof)';
export const ANCHOR_DENSITY_SPARSE_MESSAGE =
  'Signed checkpoint anchoring is too sparse for the claimed session (density gate)';
export const SIGNED_CHECKPOINTS_MISSING_MESSAGE = 'Signed checkpoints are required but the proof has none';
export const TERMINAL_ANCHOR_MISSING_MESSAGE =
  'A signed checkpoint on the final event is required but the last events are not covered by one';

/** 任意の options から 4 要件だけを取り出し、未指定を false に倒す。 */
export function normalizeAcceptancePolicy(policy: AcceptancePolicy): Required<AcceptancePolicy> {
  return {
    requireRootAnchor: policy.requireRootAnchor === true,
    requireAnchorDensity: policy.requireAnchorDensity === true,
    requireSignedCheckpoints: policy.requireSignedCheckpoints === true,
    requireTerminalAnchor: policy.requireTerminalAnchor === true,
  };
}

/** 要件を 1 つでも立てたか (verify-cli が Policy 節を出すかの判断に使う)。 */
export function hasAcceptancePolicy(applied: Required<AcceptancePolicy>): boolean {
  return (
    applied.requireRootAnchor ||
    applied.requireAnchorDensity ||
    applied.requireSignedCheckpoints ||
    applied.requireTerminalAnchor
  );
}

/**
 * 受理ポリシーを評価する (純関数)。呼び出し側は整合性が通った proof だけを渡す。
 *
 * 違反の並びは `anchor-density-sparse` → `root-anchor-missing` → `signed-checkpoints-missing` →
 * `terminal-anchor-missing`。`verifyProofFile` は先頭の違反を `errorMessage` に入れるので、
 * 密度と root の両方に違反したときに密度の文言が出る従来の順 (密度 gate は署名 cp の失敗として
 * root gate より先に連鎖に入っていた) を保つ。
 */
export function evaluateAcceptancePolicy(
  evidence: AcceptancePolicyEvidence,
  policy: AcceptancePolicy
): AcceptancePolicyViolation[] {
  const violations: AcceptancePolicyViolation[] = [];
  const { coverage, density } = evidence.signedCheckpoints;

  // 署名 cp が 0 件なら density は null で、密度要件の対象外 (ADR-0016)。
  if (policy.requireAnchorDensity && density?.sparse) {
    violations.push({ code: 'anchor-density-sparse', message: ANCHOR_DENSITY_SPARSE_MESSAGE });
  }

  if (policy.requireRootAnchor && !evidence.examExempt && !evidence.rootAnchored) {
    violations.push({
      code: 'root-anchor-missing',
      message: evidence.isExam ? EXAM_ROOT_ANCHOR_REQUIRED_MESSAGE : ROOT_ANCHOR_REQUIRED_MESSAGE,
    });
  }

  if (policy.requireSignedCheckpoints && coverage.signedCount === 0) {
    violations.push({ code: 'signed-checkpoints-missing', message: SIGNED_CHECKPOINTS_MISSING_MESSAGE });
  }

  if (policy.requireTerminalAnchor && !coverage.terminalAnchored && coverage.unsignedTailEvents > 0) {
    violations.push({
      code: 'terminal-anchor-missing',
      message: TERMINAL_ANCHOR_MISSING_MESSAGE,
      unsignedTailEvents: coverage.unsignedTailEvents,
    });
  }

  return violations;
}
