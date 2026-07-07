/**
 * verificationWorker - ハッシュ鎖検証用Web Worker
 * メインスレッドをブロックせずにハッシュ鎖とPoSWの検証を行う
 */

import {
  CHECKPOINT_PUBLIC_KEYS,
  TypingProof,
  findCheckpointPublicKey,
  runAnalysis,
  verifyCheckpoints,
  verifyContentReplay,
  verifyFinalChainHash,
  verifyInitialHashRoot,
  verifyProofMetadata,
  verifyProofSignedCheckpoints,
  verifyExamBinding,
} from '@typedcode/shared';
import type {
  AnalysisReport,
  CheckpointData,
  ExportedProof,
  ExamPackageManifest,
  ExamProofBlock,
  FingerprintComponents,
  ProofData,
  SignedCheckpointsVerificationResult,
  StoredEvent,
} from '@typedcode/shared';
import type {
  AnchorEnvelopeIssue,
  AnchorKeyInfo,
  AnchorPoint,
  PoswMode,
  SignedCheckpointReport,
  VerificationMode,
  VerificationResultData,
} from '../types.js';

// Worker内で使用するメッセージ型
interface VerifyRequest {
  type: 'verify';
  id: string;
  mode?: VerificationMode;
  /** 試験モード (ADR-0006): 問題パッケージ。あれば exam 束縛を完全検証する。 */
  manifest?: ExamPackageManifest;
  proofData: {
    version?: string;
    typingProofHash?: string;
    typingProofData?: ProofData;
    content?: string;
    proof: {
      events: StoredEvent[];
      finalHash: string | null;
    };
    fingerprint: {
      hash: string;
      components: FingerprintComponents;
    };
    checkpoints?: CheckpointData[];
    language?: string;
    /** 試験モード (ADR-0006) の proof のみ持つ。root 式の分岐と exam 束縛検証に使う。 */
    exam?: ExamProofBlock;
  };
}

interface ProgressResponse {
  type: 'progress';
  id: string;
  current: number;
  total: number;
  phase: string;
  totalEvents?: number; // 全イベント数
  hashInfo?: { computed: string; expected: string; poswHash?: string };
}

interface ResultResponse {
  type: 'result';
  id: string;
  result: VerificationResultData;
}

interface ErrorResponse {
  type: 'error';
  id: string;
  error: string;
}

/**
 * 進捗メッセージを送信
 */
function sendProgress(
  id: string,
  current: number,
  total: number,
  phase: string,
  totalEvents?: number,
  hashInfo?: { computed: string; expected: string; poswHash?: string }
): void {
  const msg: ProgressResponse = {
    type: 'progress',
    id,
    current,
    total,
    phase,
    totalEvents,
    hashInfo,
  };
  self.postMessage(msg);
}

/**
 * 結果メッセージを送信
 */
function sendResult(id: string, result: VerificationResultData): void {
  const msg: ResultResponse = {
    type: 'result',
    id,
    result,
  };
  self.postMessage(msg);
}

/**
 * エラーメッセージを送信
 */
function sendError(id: string, error: string): void {
  const msg: ErrorResponse = {
    type: 'error',
    id,
    error,
  };
  self.postMessage(msg);
}

/**
 * PoSW統計を計算
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

function poswModeFor(mode: VerificationMode): PoswMode {
  switch (mode) {
    case 'fast':
      return 'skipped';
    case 'audit':
      // Phase 2 ではプレースホルダ (現状 full と同じ挙動)
      return 'full';
    case 'full':
    default:
      return 'full';
  }
}

/**
 * 検証を実行
 */
async function verify(request: VerifyRequest): Promise<void> {
  const { id, proofData } = request;
  const mode: VerificationMode = request.mode ?? 'full';
  const skipPosw = mode === 'fast';

  try {
    const typingProof = new TypingProof();

    // 1. メタデータ整合性の検証
    let metadataValid = false;
    let rootValid = false;
    let rootAnchored = false;
    let isPureTyping = false;
    let metadataMessage: string | undefined;

    const totalEvents = proofData.proof?.events?.length ?? 0;

    // content は空文字列を許可（初期化のみのファイル）
    const hasContent = proofData.content !== undefined && proofData.content !== null;
    if (proofData.typingProofHash && proofData.typingProofData && hasContent) {
      sendProgress(id, 1, 3, 'metadata', totalEvents);

      const hashVerification = await typingProof.verifyTypingProofHash(
        proofData.typingProofHash,
        proofData.typingProofData,
        proofData.content ?? ''
      );

      // 上の guard で typingProofData は defined だが、TS は narrowing できないので
      // 明示的に narrowed 型として渡す。
      const narrowedProof = proofData as unknown as ExportedProof;
      const rootVerification = await verifyInitialHashRoot(narrowedProof);
      const eventMetadataVerification = verifyProofMetadata(proofData.typingProofData, proofData.proof?.events ?? []);
      rootValid = rootVerification.valid;
      rootAnchored = rootVerification.rootAnchored; // ADR-0017: serverNonce 付きトークンで root がアンカーされたか
      metadataValid = hashVerification.valid && rootValid && eventMetadataVerification.valid;
      metadataMessage = !hashVerification.valid
        ? hashVerification.reason
        : !rootVerification.valid
          ? rootVerification.reason
          : eventMetadataVerification.reason;
      isPureTyping = eventMetadataVerification.isPureTyping;
    } else {
      // メタデータがない場合はサポート対象外（v3.0.0以降が必要）
      // Worker 内ではユーザーのロケール設定 (localStorage) を参照できないため、
      // 翻訳キーをそのまま送り、メインスレッド側 (VerificationController) で t() 解決する
      sendError(id, 'errors.unsupportedFormat');
      return;
    }

    sendProgress(id, 2, 3, 'metadata', totalEvents);

    // 2. ハッシュ鎖の検証
    if (!proofData.proof?.events) {
      sendError(id, 'errors.noEvents');
      return;
    }

    typingProof.events = proofData.proof.events;
    typingProof.currentHash = proofData.proof.finalHash;

    // チェックポイントは未署名の補助情報なので、成功判定には常に全件検証を使う。
    // fast モードでも sequence / timestamp / previousHash / hash 連鎖は完全検証する。
    // skip するのは PoSW の反復再計算 (1 event あたり SHA-256 1 万回) のみ。
    const chainVerification = await typingProof.verify(
      (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => {
        sendProgress(id, current, total, 'chain', totalEvents, hashInfo);
      },
      { skipPosw }
    );

    sendProgress(id, 3, 3, 'complete', totalEvents);
    const finalHashVerification = chainVerification.valid
      ? verifyFinalChainHash(proofData as unknown as ExportedProof, chainVerification.computedHash)
      : { valid: false, reason: chainVerification.message };
    const contentVerification = verifyContentReplay(proofData.proof.events, proofData.content ?? '');
    const checkpointVerification = await verifyCheckpoints(proofData.proof.events, proofData.checkpoints);

    // 3. Signed checkpoint 検証 (モード非依存)
    // 上の metadata guard で typingProofData は defined 済み
    let signedCheckpointResult: SignedCheckpointsVerificationResult | undefined;
    try {
      const narrowedForSigned = proofData as unknown as ExportedProof;
      signedCheckpointResult = await verifyProofSignedCheckpoints(narrowedForSigned);
    } catch (err) {
      // signed checkpoint 検証中の例外で全体を落とさない (registry / 鍵 import 失敗等)
      signedCheckpointResult = {
        valid: false,
        anchored: false,
        details: [],
        coverage: { signedCount: 0, lastSignedEventIndex: null, coverageRatio: 0 },
        temporal: null,
        density: null,
        reason: `Signed checkpoint verification threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const signedCheckpointBlocks = signedCheckpointResult.anchored && !signedCheckpointResult.valid;

    const chainValid =
      chainVerification.valid &&
      finalHashVerification.valid &&
      checkpointVerification.valid &&
      contentVerification.valid &&
      !signedCheckpointBlocks;

    const verificationMessage = !metadataValid
      ? metadataMessage
      : !chainVerification.valid
        ? chainVerification.message
        : !finalHashVerification.valid
          ? finalHashVerification.reason
          : !checkpointVerification.valid
            ? checkpointVerification.reason
            : !contentVerification.valid
              ? contentVerification.reason
              : signedCheckpointBlocks
                ? signedCheckpointResult.reason
                : chainVerification.message;

    // 4. PoSW統計を計算
    const poswStats = calculatePoSWStats(proofData.proof.events);

    // 5. 「時刻アンカー」カードの根拠表示用の詳細情報を組み立てる
    const signedCheckpointReport = buildSignedCheckpointReport(proofData.checkpoints ?? [], signedCheckpointResult);

    // 5.5 試験モード (ADR-0006): exam ブロックがあれば束縛検証結果を組み立てる。
    // root 束縛は rootValid (verifyInitialHashRoot の exam 分岐) で既に検証済み・package 不要。
    // manifest が渡されたときのみ署名→packageHash→root→内容ハッシュ→time-box まで完全検証する。
    let examResult: VerificationResultData['exam'];
    if (proofData.exam) {
      let examBinding: NonNullable<VerificationResultData['exam']>['binding'];
      if (request.manifest) {
        try {
          examBinding = await verifyExamBinding(proofData as unknown as ExportedProof, request.manifest);
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
      examResult = {
        present: true,
        rootValid,
        packageProvided: !!request.manifest,
        binding: examBinding,
      };
    }

    // 5.7 分析層 (ADR-0009): 検証と直交する post-hoc 分析。advisory であって判定ではない
    // (valid には一切反映しない)。分析の失敗は検証結果を落とさない。
    let analysis: AnalysisReport | undefined;
    try {
      analysis = await runAnalysis({
        proof: proofData as unknown as ExportedProof,
        verification: {
          valid: metadataValid && chainValid,
          metadataValid,
          rootValid,
          rootAnchored,
          chainValid,
          finalHashValid: finalHashVerification.valid,
          contentValid: contentVerification.valid,
          checkpointValid: checkpointVerification.valid,
          isPureTyping,
          poswSkipped: skipPosw,
          signedCheckpoints: signedCheckpointResult,
        },
      });
    } catch {
      analysis = undefined;
    }

    // 6. 結果を送信
    sendResult(id, {
      metadataValid,
      rootValid,
      rootAnchored,
      chainValid,
      finalHashValid: finalHashVerification.valid,
      contentValid: contentVerification.valid,
      checkpointValid: checkpointVerification.valid,
      isPureTyping,
      message: verificationMessage,
      errorAt: chainVerification.errorAt ?? checkpointVerification.errorAt ?? signedCheckpointResult.errorAt,
      totalEvents,
      poswStats,
      verificationMode: mode,
      poswMode: poswModeFor(mode),
      signedCheckpointValid: signedCheckpointResult.anchored ? signedCheckpointResult.valid : undefined,
      signedCheckpointAnchored: signedCheckpointResult.anchored,
      signedCheckpointCoverage: signedCheckpointResult.coverage,
      signedCheckpointTemporal: signedCheckpointResult.temporal,
      signedCheckpointDensity: signedCheckpointResult.density,
      signedCheckpointReason: signedCheckpointResult.reason,
      signedCheckpointReport,
      analysis,
      exam: examResult,
    });
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
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
function buildSignedCheckpointReport(
  checkpoints: readonly CheckpointData[],
  result: SignedCheckpointsVerificationResult
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
    const entry = findCheckpointPublicKey(keyId, CHECKPOINT_PUBLIC_KEYS);
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

// メッセージハンドラ
self.onmessage = async (event: MessageEvent<VerifyRequest>) => {
  const { type } = event.data;

  if (type === 'verify') {
    await verify(event.data);
  }
};
