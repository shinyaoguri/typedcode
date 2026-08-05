/**
 * proofVerification - verify (web) の検証実行 (Web Worker から呼ばれる純ロジック)
 *
 * **検証そのものは shared の `verifyProofFile` に全面委譲する** (#211)。ここは
 * 「shared の結果を UI 型 (VerificationResultData) に写す」だけのアダプタで、判定ロジックを
 * 書かない (verify/CLAUDE.md の不変条件: shared の検証ロジックを再実装しない)。
 *
 * 過去にここでレイヤを再合成していたため、
 * - `sessionStartToken` ↔ 署名 cp の sessionId 突合 (spec §6.3) が web だけ欠落
 * - `chainValid` に署名 cp の失敗を畳み込み、整合性チップが誤って FAILED になる (ADR-0020 違反)
 * という乖離が生まれていた。web↔CLI パリティは `__tests__/webCliParity.test.ts` が固定する (#216)。
 */

import {
  CHECKPOINT_PUBLIC_KEYS,
  findCheckpointPublicKey,
  runAnalysis,
  summarizeAnalysisForAssurance,
  verifyExamBinding,
  verifyProofFile,
} from '@typedcode/shared';
import type {
  AnalysisReport,
  AssuranceInput,
  CheckpointData,
  CheckpointPublicKey,
  ExamPackageManifest,
  ProofFile as SharedProofFile,
  SignedCheckpointsVerificationResult,
  StoredEvent,
} from '@typedcode/shared';
import type {
  AnchorEnvelopeIssue,
  AnchorKeyInfo,
  AnchorPoint,
  PoswMode,
  ProofFile,
  SignedCheckpointReport,
  VerificationMode,
  VerificationResultData,
} from '../types.js';

/** 検証以前に弾く不備 (i18n キー)。Worker はこれを sendError で返す。 */
export type UnsupportedProofReason = 'errors.unsupportedFormat' | 'errors.noEvents';

export interface RunProofVerificationOptions {
  mode?: VerificationMode;
  /** 試験モード (ADR-0006): 問題パッケージ。あれば exam 束縛を完全検証する。 */
  manifest?: ExamPackageManifest;
  /** チェーン検証の進捗 (current, total)。shared の `VerificationProgressCallback` と同形。 */
  onChainProgress?: (current: number, total: number) => void;
  /** 公開鍵レジストリ (テストから注入)。未指定なら shared の既定 registry。 */
  signedCheckpointKeyRegistry?: readonly CheckpointPublicKey[];
}

/**
 * 検証に入る前の形式チェック。null なら検証可能。
 * metadata (v3.0.0 以降) と events が無い proof は検証対象外として UI にエラーを出す。
 */
export function findUnsupportedProofReason(proof: ProofFile): UnsupportedProofReason | null {
  // content は空文字列を許可（初期化のみのファイル）
  const hasContent = proof.content !== undefined && proof.content !== null;
  if (!proof.typingProofHash || !proof.typingProofData || !hasContent) {
    return 'errors.unsupportedFormat';
  }
  if (!proof.proof?.events) {
    return 'errors.noEvents';
  }
  return null;
}

function poswModeFor(mode: VerificationMode): PoswMode {
  switch (mode) {
    case 'fast':
      return 'skipped';
    case 'audit':
      // Phase 2 ではプレースホルダ (現状 full と同じ挙動)
      return 'full';
    default:
      return 'full';
  }
}

/**
 * PoSW統計を計算 (表示専用。判定には使わない)
 */
function calculatePoSWStats(events: StoredEvent[]): VerificationResultData['poswStats'] {
  const eventsWithPoSW = events.filter((event) => 'posw' in event && event.posw && typeof event.posw === 'object');

  if (eventsWithPoSW.length === 0) {
    return undefined;
  }

  let totalComputeTime = 0;
  let iterations = 0;

  for (const event of eventsWithPoSW) {
    const posw = event.posw as { iterations: number; computeTimeMs: number };
    totalComputeTime += posw.computeTimeMs;
    if (iterations === 0) {
      iterations = posw.iterations;
    }
  }

  const avgTimeMs = eventsWithPoSW.length > 0 ? totalComputeTime / eventsWithPoSW.length : 0;

  return {
    count: eventsWithPoSW.length,
    avgTimeMs,
    totalTimeMs: totalComputeTime,
    iterations,
  };
}

/** signed checkpoint 検証が省略された場合の空結果 (型を埋めるためのみ)。 */
const EMPTY_SIGNED_CHECKPOINTS: SignedCheckpointsVerificationResult = {
  valid: false,
  anchored: false,
  details: [],
  coverage: { signedCount: 0, lastSignedEventIndex: null, coverageRatio: 0 },
  temporal: null,
  density: null,
};

/**
 * 検証を実行し UI 型の結果を返す。
 *
 * 手順は verify-cli (`packages/verify-cli/src/verify.ts`) と同じ順序:
 * exam 束縛 → `verifyProofFile` → `runAnalysis` (advisory)。
 */
export async function runProofVerification(
  proof: ProofFile,
  options: RunProofVerificationOptions = {}
): Promise<VerificationResultData> {
  const mode: VerificationMode = options.mode ?? 'full';
  const sharedProof = proof as unknown as SharedProofFile;
  const totalEvents = proof.proof?.events?.length ?? 0;

  // 1. 試験モード (ADR-0006): exam ブロックがあり package も渡されたときのみ完全束縛を検証する。
  //    root アンカー gate (#131) の exam 免除は「検証済み束縛」に基づくので verifyProofFile より前に計算する。
  let examBinding: NonNullable<VerificationResultData['exam']>['binding'];
  if (proof.exam && options.manifest) {
    try {
      examBinding = await verifyExamBinding(sharedProof, options.manifest);
    } catch (err) {
      examBinding = {
        valid: false,
        packageSignatureValid: false,
        packageHashMatches: false,
        rootMatches: false,
        problemContentHashMatches: false,
        timeBox: null,
        reason: `Exam binding verification threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. 検証本体。metadata / chain / finalHash / content / checkpoint / 署名 cp /
  //    sessionStartToken 突合 の合成はすべて shared 側 (CLI と同一の結論)。
  const result = await verifyProofFile(sharedProof, options.onChainProgress, {
    mode,
    examBindingVerified: examBinding?.valid === true,
    signedCheckpointKeyRegistry: options.signedCheckpointKeyRegistry,
  });

  const signedCheckpoints = result.signedCheckpoints ?? EMPTY_SIGNED_CHECKPOINTS;

  // 3. 分析層 (ADR-0009): 検証と直交する post-hoc 分析。advisory であって判定ではない
  //    (valid には一切反映しない)。分析の失敗は検証結果を落とさない。
  let analysis: AnalysisReport | undefined;
  try {
    analysis = await runAnalysis({ proof: sharedProof, verification: result });
  } catch {
    analysis = undefined;
  }

  const examResult: VerificationResultData['exam'] = proof.exam
    ? {
        present: true,
        rootValid: result.rootValid ?? false,
        packageProvided: !!options.manifest,
        binding: examBinding,
      }
    : undefined;

  return {
    valid: result.valid,
    metadataValid: result.metadataValid,
    rootValid: result.rootValid,
    rootAnchored: result.rootAnchored,
    sessionTokenMismatch: result.sessionTokenMismatch,
    chainValid: result.chainValid,
    finalHashValid: result.finalHashValid,
    contentValid: result.contentValid,
    checkpointValid: result.checkpointValid,
    isPureTyping: result.isPureTyping,
    message: result.errorMessage,
    errorAt: result.errorAt,
    totalEvents,
    poswStats: calculatePoSWStats(proof.proof.events),
    verificationMode: mode,
    poswMode: poswModeFor(mode),
    signedCheckpointValid: signedCheckpoints.anchored ? signedCheckpoints.valid : undefined,
    signedCheckpointAnchored: signedCheckpoints.anchored,
    signedCheckpointCoverage: signedCheckpoints.coverage,
    signedCheckpointTemporal: signedCheckpoints.temporal,
    signedCheckpointDensity: signedCheckpoints.density,
    signedCheckpointReason: signedCheckpoints.reason,
    signedCheckpointReport: buildSignedCheckpointReport(
      proof.checkpoints ?? [],
      signedCheckpoints,
      options.signedCheckpointKeyRegistry
    ),
    analysis,
    exam: examResult,
  };
}

/**
 * UI の総合判定。verify-cli の `valid` (= `verifyProofFile` の valid × exam 束縛 × スクショ改竄)
 * と**同じ合成**にする。ここが CLI とずれると「Web で OK / CLI で NG」が起きる。
 */
export function isOverallValid(
  result: VerificationResultData,
  options: { screenshotsTampered?: number } = {}
): boolean {
  // package が渡されたときのみ束縛失敗を全体 fail にする (proof 自己整合とは別軸の真正性)。
  const examBindingFailed = !!result.exam?.packageProvided && result.exam.binding?.valid === false;
  return result.valid && !examBindingFailed && (options.screenshotsTampered ?? 0) === 0;
}

/**
 * 三層保証 (ADR-0020) の導出入力を検証結果から組み立てる。
 *
 * verify-cli (`packages/verify-cli/src/verify.ts`) の同じ写像と**一致していること**が
 * web↔CLI パリティの要。導出そのものは shared の `deriveAssurance` に委譲する。
 */
export function buildAssuranceInput(
  result: VerificationResultData,
  options: { screenshotsTampered?: number } = {}
): AssuranceInput {
  return {
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    screenshotsTampered: options.screenshotsTampered,
    exam: result.exam
      ? {
          present: true,
          packageProvided: result.exam.packageProvided,
          bindingValid: result.exam.binding?.valid,
        }
      : undefined,
    rootAnchored: result.rootAnchored ?? false,
    signedCheckpoints:
      result.signedCheckpointAnchored !== undefined
        ? {
            anchored: result.signedCheckpointAnchored,
            valid: result.signedCheckpointValid,
            sparse: result.signedCheckpointDensity?.sparse,
            postHocSuspected: result.signedCheckpointTemporal?.postHocSuspected,
          }
        : undefined,
    isPureTyping: result.isPureTyping,
    analysis: result.analysis ? summarizeAnalysisForAssurance(result.analysis) : undefined,
  };
}

/**
 * Signed checkpoint カードの「展開時の根拠」表示に渡す詳細情報を組み立てる。
 *
 * 含める情報:
 * - 検証の母集団: proof 内の checkpoint 総数 / 署名済み数 / valid 数
 * - 範囲: 最初の anchor (cp #0) と最後の anchor の (checkpointIndex, eventIndex,
 *   serverTimestamp, clientTimestamp)。Coverage 行の補強として使える。
 * - 鍵レジストリ整合: 各 envelope の keyId を一意化して registry を引き、
 *   description / status / validFrom 等を返す (鍵 rotation や revoke の根拠)。
 * - 失敗 / 警告 envelope の特定: verifySignedCheckpoints の details から
 *   valid=false や warning 付きのものを抜き出す。エラー位置の根拠になる。
 */
export function buildSignedCheckpointReport(
  checkpoints: readonly CheckpointData[],
  result: SignedCheckpointsVerificationResult,
  registry: readonly CheckpointPublicKey[] | undefined = CHECKPOINT_PUBLIC_KEYS
): SignedCheckpointReport {
  const signed = checkpoints.filter((cp) => cp.signature);
  const detailByEvent = new Map(result.details.map((d) => [d.eventIndex, d]));

  const firstEnvelope = signed[0]?.signature;
  const lastEnvelope = signed[signed.length - 1]?.signature;

  const toAnchor = (
    env:
      | { payload: { checkpointIndex: number; eventIndex: number; serverTimestamp: string; clientTimestamp: string } }
      | undefined
  ): AnchorPoint | undefined =>
    env
      ? {
          checkpointIndex: env.payload.checkpointIndex,
          eventIndex: env.payload.eventIndex,
          serverTimestamp: env.payload.serverTimestamp,
          clientTimestamp: env.payload.clientTimestamp,
        }
      : undefined;

  // 一意な keyId を抽出 (順序保持)
  const uniqueKeyIds: string[] = [];
  const seenKeyIds = new Set<string>();
  for (const cp of signed) {
    const kid = cp.signature?.keyId;
    if (!kid || seenKeyIds.has(kid)) continue;
    seenKeyIds.add(kid);
    uniqueKeyIds.push(kid);
  }

  const keys: AnchorKeyInfo[] = uniqueKeyIds.map((keyId) => {
    const entry = findCheckpointPublicKey(keyId, registry);
    if (!entry) {
      return { keyId, status: 'unknown' };
    }
    return {
      keyId,
      status: entry.status,
      algorithm: entry.algorithm,
      description: entry.description,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
      revokedAt: entry.revokedAt,
    };
  });

  const failedEnvelopes: AnchorEnvelopeIssue[] = [];
  const warningEnvelopes: AnchorEnvelopeIssue[] = [];
  for (const cp of signed) {
    const payload = cp.signature?.payload;
    if (!payload) continue;
    const detail = detailByEvent.get(payload.eventIndex);
    if (detail && !detail.valid) {
      failedEnvelopes.push({
        checkpointIndex: payload.checkpointIndex,
        eventIndex: payload.eventIndex,
        reason: detail.reason ?? 'invalid',
      });
    }
    if (detail?.warning) {
      warningEnvelopes.push({
        checkpointIndex: payload.checkpointIndex,
        eventIndex: payload.eventIndex,
        reason: detail.warning,
      });
    }
  }

  const validCount = result.details.filter((d) => d.valid).length;

  return {
    totalCheckpoints: checkpoints.length,
    signedCount: signed.length,
    validCount,
    firstSeenAt: firstEnvelope?.payload.firstSeenAt,
    initialEventChainHash: firstEnvelope?.payload.initialEventChainHash,
    firstAnchor: toAnchor(firstEnvelope),
    lastAnchor: toAnchor(lastEnvelope),
    keys,
    failedEnvelopes,
    warningEnvelopes,
  };
}
