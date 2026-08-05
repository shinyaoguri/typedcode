/**
 * verificationWorker - ハッシュ鎖検証用Web Worker
 * メインスレッドをブロックせずにハッシュ鎖とPoSWの検証を行う
 *
 * ここはメッセージの入出力だけを担う薄いアダプタ。検証と結果の組み立ては
 * `services/proofVerification.ts` (最終的には shared の `verifyProofFile`) が持つ。
 * Worker 内に検証ロジックを書き戻さないこと (#211: 再実装が web↔CLI の乖離を生んだ)。
 */

import { findUnsupportedProofReason, runProofVerification } from '../services/proofVerification.js';
import type { ExamPackageManifest } from '@typedcode/shared';
import type { ProofFile, VerificationMode, VerificationResultData } from '../types.js';

// Worker内で使用するメッセージ型
interface VerifyRequest {
  type: 'verify';
  id: string;
  mode?: VerificationMode;
  /** 試験モード (ADR-0006): 問題パッケージ。あれば exam 束縛を完全検証する。 */
  manifest?: ExamPackageManifest;
  proofData: ProofFile;
}

interface ProgressResponse {
  type: 'progress';
  id: string;
  current: number;
  total: number;
  phase: string;
  totalEvents?: number; // 全イベント数
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
function sendProgress(id: string, current: number, total: number, phase: string, totalEvents?: number): void {
  const msg: ProgressResponse = {
    type: 'progress',
    id,
    current,
    total,
    phase,
    totalEvents,
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
 * 検証を実行
 */
async function verify(request: VerifyRequest): Promise<void> {
  const { id, proofData } = request;
  const mode: VerificationMode = request.mode ?? 'full';

  try {
    const totalEvents = proofData.proof?.events?.length ?? 0;

    // メタデータ / events を持たない proof はサポート対象外 (v3.0.0 以降が必要)。
    // Worker 内ではユーザーのロケール設定 (localStorage) を参照できないため、翻訳キーを
    // そのまま送り、メインスレッド側 (VerificationController) で t() 解決する。
    const unsupported = findUnsupportedProofReason(proofData);
    if (unsupported) {
      sendError(id, unsupported);
      return;
    }

    sendProgress(id, 1, 3, 'metadata', totalEvents);

    const result = await runProofVerification(proofData, {
      mode,
      manifest: request.manifest,
      onChainProgress: (current, total) => {
        sendProgress(id, current, total, 'chain', totalEvents);
      },
    });

    sendProgress(id, 3, 3, 'complete', totalEvents);
    sendResult(id, result);
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
