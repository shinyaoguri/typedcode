/**
 * sandbox runner (iframe) から親 (エディタ) へのメッセージの形と、その検査 (#290)。
 *
 * runner は opaque origin なので `e.origin` は `'null'` で識別に使えない。親は
 * `e.source === iframe.contentWindow` (SandboxRunner 側) とこの形の検査の両方を通ったものだけを扱う。
 * runId が今の run と違うもの・型の合わないフィールドを持つものは捨てる (古い run の遅れた出力や、
 * 形の違うメッセージで状態を壊さないため)。
 *
 * runner → 親:
 * - `{ type: 'ready', runId }`: runner がメッセージを受けられるようになった
 * - `{ type: 'stdout' | 'stderr', runId, text }`: 出力
 * - `{ type: 'done', runId, outcome: 'success' | 'failure', exitCode }`: Worker 内の実行が完了した
 * - `{ type: 'fatal', runId, message }`: Worker を作れない / Worker が error イベントで落ちた
 *
 * 親 → runner: `{ type: 'run', runId, code, outputBudgetChars }`
 */

export type SandboxMessage =
  | { type: 'ready' }
  | { type: 'stdout' | 'stderr'; text: string }
  | { type: 'done'; outcome: 'success' | 'failure'; exitCode: number }
  | { type: 'fatal'; message: string };

/** 親 → runner の実行要求 */
export interface SandboxRunRequest {
  type: 'run';
  runId: string;
  code: string;
  outputBudgetChars: number;
}

/**
 * 受け取ったメッセージを検査して、今の run (`runId`) に宛てた正しい形のものだけを返す。
 * それ以外 (別の run・未知の type・フィールドの型違い・オブジェクトでない) は null。
 */
export function parseSandboxMessage(data: unknown, runId: string): SandboxMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== 'string' || d.runId !== runId) return null;
  switch (d.type) {
    case 'ready':
      return { type: 'ready' };
    case 'stdout':
    case 'stderr':
      return typeof d.text === 'string' ? { type: d.type, text: d.text } : null;
    case 'done':
      if ((d.outcome === 'success' || d.outcome === 'failure') && Number.isInteger(d.exitCode)) {
        return { type: 'done', outcome: d.outcome, exitCode: d.exitCode as number };
      }
      return null;
    case 'fatal':
      return typeof d.message === 'string' ? { type: 'fatal', message: d.message } : null;
    default:
      return null;
  }
}
