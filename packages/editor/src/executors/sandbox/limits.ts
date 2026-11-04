/**
 * ユーザーの JS / TS を sandbox で実行するときの上限 (#290 / ADR-0041)。
 *
 * どれも「超えたら実行環境 (iframe + Worker) ごと捨てる」上限で、ユーザーコードの協力を当てにしない。
 * - 時間: 超えたら `timeout`
 * - 出力: stdout + stderr の合計文字数。超えたら打ち切りを通知して `error` (大量出力でエディタの
 *   メモリと記録・保存の余地を奪わないため。#290 の 09-09 要件)
 * - 準備: runner (iframe 内のスクリプト) が準備完了を返すまで。来なければ初期化失敗として `error`
 */

/** 実行時間の上限 (ミリ秒)。超えたら iframe ごと除去して `timeout` を記録する */
export const EXECUTION_TIMEOUT_MS = 30_000;

/** stdout + stderr の合計文字数の上限。超えたら打ち切りを通知して `error` を記録する */
export const OUTPUT_BUDGET_CHARS = 1_000_000;

/** runner の準備応答を待つ上限 (ミリ秒)。来なければ初期化失敗として `error` を記録する */
export const RUNNER_READY_TIMEOUT_MS = 10_000;

export interface ExecutionLimits {
  timeoutMs: number;
  outputBudgetChars: number;
  readyTimeoutMs: number;
}

/** 既定の上限 */
export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  timeoutMs: EXECUTION_TIMEOUT_MS,
  outputBudgetChars: OUTPUT_BUDGET_CHARS,
  readyTimeoutMs: RUNNER_READY_TIMEOUT_MS,
});

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 上書きの値 (形が不明なもの) を既定値に重ねる。正の有限数でない項目は既定値のまま。
 * E2E が待ち時間を縮めるための dev 限定の上書き (`window.__tcExecLimits`) を受けるために使う。
 */
export function resolveExecutionLimits(override: unknown): ExecutionLimits {
  const limits: ExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS };
  if (typeof override !== 'object' || override === null) return limits;
  const o = override as Record<string, unknown>;
  limits.timeoutMs = positiveNumber(o.timeoutMs) ?? limits.timeoutMs;
  limits.outputBudgetChars = Math.floor(positiveNumber(o.outputBudgetChars) ?? limits.outputBudgetChars);
  limits.readyTimeoutMs = positiveNumber(o.readyTimeoutMs) ?? limits.readyTimeoutMs;
  return limits;
}

declare global {
  interface Window {
    /**
     * E2E 専用 (dev ビルドのみ読む)。実行の上限を縮めてタイムアウト・出力予算の経路を短時間で通す。
     * 本番ビルドでは読まない (`import.meta.env.DEV` のガードごと除去される。production-build.spec が見張る)
     */
    __tcExecLimits?: Partial<ExecutionLimits>;
  }
}

/** 今回の実行に使う上限。dev ビルドに限り `window.__tcExecLimits` の上書きを重ねる */
export function getExecutionLimits(): ExecutionLimits {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    return resolveExecutionLimits(window.__tcExecLimits);
  }
  return { ...DEFAULT_EXECUTION_LIMITS };
}
