/**
 * verificationWorker - ハッシュ鎖検証用Web Worker
 * メインスレッドをブロックせずにハッシュ鎖とPoSWの検証を行う
 */

import {
  TypingProof,
  verifyCheckpoints,
  verifyContentReplay,
  verifyFinalChainHash,
  verifyInitialHashRoot,
  verifyProofMetadata,
} from '@typedcode/shared';
import type { StoredEvent, CheckpointData, ProofData, FingerprintComponents } from '@typedcode/shared';

// Worker内で使用するメッセージ型
interface VerifyRequest {
  type: 'verify';
  id: string;
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
  result: {
    metadataValid: boolean;
    rootValid?: boolean;
    chainValid: boolean;
    finalHashValid?: boolean;
    contentValid?: boolean;
    checkpointValid?: boolean;
    isPureTyping: boolean;
    message?: string;
    errorAt?: number;
    totalEvents?: number;
    poswStats?: {
      count: number;
      avgTimeMs: number;
      totalTimeMs: number;
      iterations: number;
    };
    sampledResult?: {
      sampledSegments: Array<{
        startIndex: number;
        endIndex: number;
        eventCount: number;
        startHash: string;
        endHash: string;
        verified: boolean;
      }>;
      totalSegments: number;
      totalEventsVerified: number;
      totalEvents: number;
    };
  };
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
function sendResult(id: string, result: ResultResponse['result']): void {
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
function calculatePoSWStats(events: StoredEvent[]): ResultResponse['result']['poswStats'] {
  const eventsWithPoSW = events.filter(
    (event) => 'posw' in event && event.posw && typeof event.posw === 'object'
  );

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

/**
 * 検証を実行
 */
async function verify(request: VerifyRequest): Promise<void> {
  const { id, proofData } = request;

  try {
    const typingProof = new TypingProof();

    // 1. メタデータ整合性の検証
    let metadataValid = false;
    let rootValid = false;
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

      const rootVerification = await verifyInitialHashRoot(proofData);
      const eventMetadataVerification = verifyProofMetadata(
        proofData.typingProofData,
        proofData.proof?.events ?? []
      );
      rootValid = rootVerification.valid;
      metadataValid = hashVerification.valid && rootValid && eventMetadataVerification.valid;
      metadataMessage = !hashVerification.valid
        ? hashVerification.reason
        : !rootVerification.valid
          ? rootVerification.reason
          : eventMetadataVerification.reason;
      isPureTyping = eventMetadataVerification.isPureTyping;
    } else {
      // メタデータがない場合はサポート対象外（v3.0.0以降が必要）
      sendError(id, 'サポートされていないフォーマット: メタデータがありません（v3.0.0以降が必要）');
      return;
    }

    sendProgress(id, 2, 3, 'metadata', totalEvents);

    // 2. ハッシュ鎖の検証
    if (!proofData.proof?.events) {
      sendError(id, 'No events found in proof data');
      return;
    }

    typingProof.events = proofData.proof.events;
    typingProof.currentHash = proofData.proof.finalHash;

    // チェックポイントは未署名の補助情報なので、成功判定には常に全件検証を使う
    const chainVerification = await typingProof.verify(
      (current: number, total: number, hashInfo?: { computed: string; expected: string; poswHash: string }) => {
        sendProgress(id, current, total, 'chain', totalEvents, hashInfo);
      }
    );

    sendProgress(id, 3, 3, 'complete', totalEvents);
    const finalHashVerification = chainVerification.valid
      ? verifyFinalChainHash(proofData, chainVerification.computedHash)
      : { valid: false, reason: chainVerification.message };
    const contentVerification = verifyContentReplay(
      proofData.proof.events,
      proofData.content ?? ''
    );
    const checkpointVerification = await verifyCheckpoints(proofData.proof.events, proofData.checkpoints);
    const chainValid =
      chainVerification.valid &&
      finalHashVerification.valid &&
      checkpointVerification.valid &&
      contentVerification.valid;
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
              : chainVerification.message;

    // 3. PoSW統計を計算
    const poswStats = calculatePoSWStats(proofData.proof.events);

    // 4. 結果を送信
    sendResult(id, {
      metadataValid,
      rootValid,
      chainValid,
      finalHashValid: finalHashVerification.valid,
      contentValid: contentVerification.valid,
      checkpointValid: checkpointVerification.valid,
      isPureTyping,
      message: verificationMessage,
      errorAt: chainVerification.errorAt ?? checkpointVerification.errorAt,
      totalEvents,
      poswStats,
    });
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
}

// メッセージハンドラ
self.onmessage = async (event: MessageEvent<VerifyRequest>) => {
  const { type } = event.data;

  if (type === 'verify') {
    await verify(event.data);
  }
};
