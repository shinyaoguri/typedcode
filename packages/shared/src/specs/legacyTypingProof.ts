/**
 * legacy typing proof 1.2.0 の検証器 (#809)。
 *
 * 中身は既存の `verifyProofFile` (と、exam なら `verifyExamBinding`) そのもので、規則は 1 つも変えない。
 * ここはその結果を共通の結果 (`types.ts`) の軸へ写すだけ。写すときは自由文 (`errorMessage` / `reason`) を
 * 読まず、下位の結果の構造化したフィールド (`chainFailure`・`keyStatus` など) だけを使う。整合性は写した
 * `checks` だけから導く (`deriveIntegrity`)。legacy が `integrityValid: false` にする proof は、必ずどれかの
 * 検査が `fail` になる (= この入口は legacy より甘くならない)。
 *
 * 1.2.0 の中の root の方式 (アンカー無し / sessionStartToken / exam v1 / exam v2) は、いまと同じく
 * ブロックの有無で分かれる (`verifyInitialHashRoot`)。これは 1.2.0 の仕様の一部 (system-spec §6.5)。
 */

import { normalizeAcceptancePolicy, type AcceptancePolicyResult } from '../acceptancePolicy.js';
import { ALL_CHECKPOINT_KEY_ENVIRONMENTS } from '../checkpointKeys/keyEnvironment.js';
import type { RegistryKeyTrustStatus } from '../checkpointKeys/keyValidity.js';
import {
  parseExamPackageManifest,
  verifyExamBinding,
  type ExamBindingVerificationResult,
} from '../exam/examPackage.js';
import { verifySessionStartToken } from '../sessionStartToken.js';
import type { SignedCheckpointsVerificationResult } from '../types.js';
import { verifyProofFile, type FullVerificationResult, type ProofFile } from '../verification.js';
import type {
  SpecCheck,
  SpecChecks,
  SpecIntegrity,
  SpecLimitationCode,
  SpecTrustedKey,
  SpecVerificationContext,
} from './types.js';

/** legacy 1.2.0 の検証の結果のうち、入口が共通の結果に組み込む部分 */
export interface LegacyTypingProofOutcome {
  integrity: SpecIntegrity;
  checks: SpecChecks;
  limitations: SpecLimitationCode[];
  keys: SpecTrustedKey[];
  acceptance: AcceptancePolicyResult;
  legacyProof: FullVerificationResult;
  examBinding?: ExamBindingVerificationResult;
}

const PASS: SpecCheck = { status: 'pass' };
const NOT_CHECKED: SpecCheck = { status: 'not-checked' };
const NOT_APPLICABLE: SpecCheck = { status: 'not-applicable' };

/** 鍵を信頼できない状態 (署名 cp の失敗を「証拠の不一致」ではなく「信頼」の側に数えるもの) */
const UNTRUSTED_KEY_STATUSES: ReadonlySet<RegistryKeyTrustStatus> = new Set([
  'unknown',
  'revoked',
  'expired',
  'not-yet-valid',
  'malformed-entry',
]);

/** 未登録の鍵の keyId を結果に載せてよい文字種 (proof 由来の値。不変条件 11) */
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const fail = (code: SpecCheck['code']): SpecCheck => ({ status: 'fail', code });

/** 証拠側の時刻を ISO 8601 に正規化する。parse できなければ載せない (生の文字列を写さない) */
function normalizeAnchor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function safeKeyId(value: unknown): string | undefined {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value) ? value : undefined;
}

function keyEntry(
  role: SpecTrustedKey['role'],
  keyId: unknown,
  status: RegistryKeyTrustStatus,
  anchor: unknown
): SpecTrustedKey {
  const entry: SpecTrustedKey = { role, status };
  const id = safeKeyId(keyId);
  if (id !== undefined) entry.keyId = id;
  const at = normalizeAnchor(anchor);
  if (at !== undefined) entry.anchor = at;
  return entry;
}

/**
 * 署名 cp の失敗が「鍵を信頼できない」ことによるか。失敗した detail (最後の detail) の `keyStatus` で決める。
 * 署名・連鎖・照合値の不一致 (= 証拠の不一致) なら false。
 */
function signedCheckpointsFailedOnTrust(result: SignedCheckpointsVerificationResult): boolean {
  const failed = result.details.at(-1);
  return failed?.keyStatus !== undefined && UNTRUSTED_KEY_STATUSES.has(failed.keyStatus);
}

/** 署名 cp の detail から鍵の信頼状態を集める。同じ鍵・同じ状態は 1 件にまとめ、anchor は最後のもの */
function checkpointKeys(proof: ProofFile, result: SignedCheckpointsVerificationResult): SpecTrustedKey[] {
  const signed = (proof.checkpoints ?? []).filter((cp) => !!cp.signature);
  const byIdentity = new Map<string, SpecTrustedKey>();
  result.details.forEach((detail, i) => {
    if (detail.keyStatus === undefined) return;
    // details は署名 cp の順に積まれる (検査で落ちたらそこで止まる) ので、i 番目の detail は i 番目の署名 cp
    const entry = keyEntry('checkpoint', detail.keyId, detail.keyStatus, signed[i]?.signature?.payload.serverTimestamp);
    byIdentity.set(`${entry.keyId ?? ''}\u0000${entry.status}`, entry);
  });
  return [...byIdentity.values()];
}

function metadataCheck(r: FullVerificationResult): SpecCheck {
  if (r.typingProofHashValid === false) return fail('typing-proof-hash-mismatch');
  if (r.eventMetadataValid === false) return fail('event-metadata-mismatch');
  // 構造の検査を通った入力は必ず照合まで進む。万一付いていなければ「確かめた」とは言わない
  return r.typingProofHashValid === true && r.eventMetadataValid === true ? PASS : NOT_CHECKED;
}

function chainCheck(r: FullVerificationResult): SpecCheck {
  if (r.chainFailure === undefined) return PASS;
  // PoSW で止まったら、その先のイベントの連結は確かめていない
  return r.chainFailure === 'posw-mismatch' ? NOT_CHECKED : fail(r.chainFailure);
}

function poswCheck(r: FullVerificationResult): SpecCheck {
  if (r.poswSkipped === true) return NOT_CHECKED;
  if (r.chainFailure === undefined) return PASS;
  // 連結の検査で止まったら、その先のイベントの PoSW は再計算していない
  return r.chainFailure === 'posw-mismatch' ? fail('posw-mismatch') : NOT_CHECKED;
}

function finalHashCheck(r: FullVerificationResult): SpecCheck {
  // 最終ハッシュの照合は verifyChain が通ったときだけ行われる
  if (r.chainFailure !== undefined) return NOT_CHECKED;
  return r.finalHashValid === true ? PASS : fail('final-hash-mismatch');
}

function checkpointsCheck(proof: ProofFile, r: FullVerificationResult): SpecCheck {
  if ((proof.checkpoints ?? []).length === 0) return NOT_APPLICABLE;
  return r.checkpointValid === true ? PASS : fail('checkpoint-mismatch');
}

function signedCheckpointsCheck(sc: SignedCheckpointsVerificationResult): SpecCheck {
  if (!sc.anchored) return NOT_APPLICABLE;
  if (sc.valid) return PASS;
  return fail(signedCheckpointsFailedOnTrust(sc) ? 'signed-checkpoint-key-untrusted' : 'signed-checkpoint-invalid');
}

function sessionAnchorCheck(proof: ProofFile, r: FullVerificationResult): SpecCheck {
  // exam の root は token を使わない (verifyInitialHashRoot は exam 分岐が先)。token が同梱されていても
  // root のアンカーには使われないので対象外にする (token の鍵も trust.keys に載せない)
  // ただし legacy は exam でも token と署名 cp の sessionId を突き合わせて integrityValid を落とすので、
  // 食い違いだけは fail に出す (legacy より甘くしない)
  if (!proof.sessionStartToken) return NOT_APPLICABLE;
  if (proof.exam) return r.sessionTokenMismatch === true ? fail('token-session-mismatch') : NOT_APPLICABLE;
  if (r.rootAnchorFailure) return fail(r.rootAnchorFailure.code);
  if (r.sessionTokenMismatch === true) return fail('token-session-mismatch');
  return r.rootValid === true && r.rootAnchored === true ? PASS : NOT_CHECKED;
}

interface ProblemBindingOutcome {
  check: SpecCheck;
  /** 渡されたパッケージを `verifyExamBinding` にかけた結果。パッケージが無い・読めないときは無い */
  binding?: ExamBindingVerificationResult;
  limitations: SpecLimitationCode[];
  keys: SpecTrustedKey[];
}

async function verifyProblemBinding(
  proof: ProofFile,
  context: SpecVerificationContext
): Promise<ProblemBindingOutcome> {
  if (!proof.exam) {
    return { check: NOT_APPLICABLE, limitations: [], keys: [] };
  }
  if (context.examPackage === undefined) {
    return {
      check: NOT_CHECKED,
      limitations: ['problem-package-not-provided'],
      keys: [],
    };
  }
  const manifest = parseExamPackageManifest(context.examPackage);
  if (!manifest) {
    return {
      check: fail('exam-package-malformed'),
      limitations: [],
      keys: [],
    };
  }
  const binding = await verifyExamBinding(proof, manifest, {
    examAuthorityRegistry: context.trust.examAuthorityKeys,
    submissionTimeMs: context.submissionTimeMs,
  });
  const keyStatus = binding.authorityKeyStatus;
  const keys =
    keyStatus === undefined
      ? []
      : [keyEntry('exam-authority', binding.registryEntry?.keyId ?? manifest.keyId, keyStatus, manifest.releaseTime)];
  const check = binding.valid
    ? PASS
    : fail(
        keyStatus !== undefined && UNTRUSTED_KEY_STATUSES.has(keyStatus)
          ? 'exam-authority-key-untrusted'
          : 'exam-binding-invalid'
      );
  return {
    check,
    binding,
    // 出題者鍵の判定に進んだら、その anchor が自己申告の releaseTime であることを示す
    limitations: keyStatus === undefined ? [] : ['exam-key-anchor-self-declared'],
    keys,
  };
}

/** token の鍵の信頼状態。root が token を使う (exam でない) ときだけ見る */
async function sessionTokenKeys(proof: ProofFile, context: SpecVerificationContext): Promise<SpecTrustedKey[]> {
  const token = proof.sessionStartToken;
  if (!token || proof.exam) return [];
  // verifyProofFile の中 (verifyInitialHashRoot) と同じ入力で同じ関数を呼ぶ。鍵の状態は判定ではなく記録に使う
  const tokenResult = await verifySessionStartToken(token, context.trust.checkpointKeys);
  if (tokenResult.keyStatus === undefined) return [];
  return [keyEntry('session-token', tokenResult.keyId, tokenResult.keyStatus, token.payload.issuedAt)];
}

/**
 * 整合性 (語彙は ADR-0020 / ADR-0031 の `proven` / `partial` / `failed`) を `checks` **だけから**導く:
 * - `failed`: どれかの検査が `fail`
 * - `partial`: `fail` が無く、どれかが `not-checked` (fast の PoSW、パッケージの無い exam の問題束縛など)
 * - `proven`: すべて `pass` か `not-applicable`
 *
 * 鍵を信頼できない失敗 (署名 cp・token・出題者鍵)、token の検証失敗、token と cp の sessionId の不一致も
 * `failed` になる。legacy の `verifyProofFile` が `integrityValid: false` にする proof に、この入口が
 * `proven` / `partial` を返さないため (legacy より甘くしない)。原因は各検査の `code` と `trust.keys` で分かる。
 * `assurance.integrity` (ADR-0020。署名 cp・token の失敗を時刻アンカー層に数える) とは別の値。
 */
function deriveIntegrity(checks: SpecChecks): SpecIntegrity {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.includes('fail')) return 'failed';
  return statuses.includes('not-checked') ? 'partial' : 'proven';
}

/**
 * legacy 1.2.0 の proof を検証する。`proof` は `identifyProofSpec` が `supported` と判定した入力
 * (構造は `isLegacyTypingProofStructure` で確かめ済み)。
 */
export async function verifyLegacyTypingProof(
  proof: ProofFile,
  context: SpecVerificationContext
): Promise<LegacyTypingProofOutcome> {
  const mode = context.mode ?? 'full';
  const problem = await verifyProblemBinding(proof, context);
  const legacyProof = await verifyProofFile(proof, context.onProgress, {
    ...normalizeAcceptancePolicy(context.policy ?? {}),
    mode,
    signedCheckpointKeyRegistry: context.trust.checkpointKeys,
    // 信頼の範囲は呼び出し側が渡した鍵の一覧そのもの (#321)。鍵の環境では絞らない: 一覧に staging の鍵を
    // 入れるかどうかを呼び出し側が決める (既定の環境の範囲に黙って落とさない。不変条件 15)
    trustedKeyEnvironments: ALL_CHECKPOINT_KEY_ENVIRONMENTS,
    // 入口が自分で検証した束縛の結果だけを渡す (呼び出し側の申告は受けない。ADR-0054 §1)
    examBindingVerified: problem.binding?.valid === true,
  });

  const signedCheckpoints = legacyProof.signedCheckpoints;
  const checks: SpecChecks = {
    structure: PASS,
    metadata: metadataCheck(legacyProof),
    root: legacyProof.rootValid === true ? PASS : fail('root-mismatch'),
    chain: chainCheck(legacyProof),
    posw: poswCheck(legacyProof),
    finalHash: finalHashCheck(legacyProof),
    content: legacyProof.contentValid === true ? PASS : fail('content-mismatch'),
    checkpoints: checkpointsCheck(proof, legacyProof),
    signedCheckpoints: signedCheckpoints ? signedCheckpointsCheck(signedCheckpoints) : NOT_CHECKED,
    sessionAnchor: sessionAnchorCheck(proof, legacyProof),
    problemBinding: problem.check,
  };

  // 1.2.0 の version は typingProofHash の入力ではない (版の名乗り替えを検出できない)
  const limitations: SpecLimitationCode[] = ['legacy-spec-version-unbound'];
  if (legacyProof.poswSkipped === true) limitations.push('posw-not-recomputed');
  limitations.push(...problem.limitations);

  const keys = [
    ...(await sessionTokenKeys(proof, context)),
    ...(signedCheckpoints ? checkpointKeys(proof, signedCheckpoints) : []),
    ...problem.keys,
  ];

  const integrity = deriveIntegrity(checks);
  // 受理ポリシーは整合性が落ちたら評価しない (ADR-0043)。legacy の評価結果は legacy の integrityValid
  // (token・署名 cp の失敗も含む) が通ったときだけ evaluated なので、それをそのまま使う
  const acceptance: AcceptancePolicyResult =
    integrity === 'failed'
      ? { applied: legacyProof.policy.applied, evaluated: false, violations: [] }
      : legacyProof.policy;

  const outcome: LegacyTypingProofOutcome = { integrity, checks, limitations, keys, acceptance, legacyProof };
  if (problem.binding) outcome.examBinding = problem.binding;
  return outcome;
}
