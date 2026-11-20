/**
 * Python の runner (opaque origin の sandbox iframe。pythonRunnerDocument.ts) と親 (PythonExecutor /
 * PythonRunner) の間のメッセージ (#649 / #719)。
 *
 * runner は親と別の origin (opaque) なので、親は受け取ったメッセージを信用しない。PythonRunner が
 * `e.source === iframe.contentWindow` と `e.origin === 'null'` を確かめ、ここの `parsePythonRunnerMessage`
 * で runner ごとの ID・type の許可リスト・各フィールドの型と長さを検査して、通ったものだけを扱う。
 *
 * 親 → runner (PythonRunner が runnerId を付けて送る。渡すのはコード・パッケージ名・stdin の行だけで、
 * proof・sessionStartToken・鍵・DB 名は渡さない):
 * - `init`: Pyodide を読み込む。`progress` を何度か返し、`ready` か `init-error` で終わる
 * - `run`: コードを実行する。`outputBudgetChars` は stdout + stderr の合計の上限 (判定の正本は親)
 * - `stdin` / `stdin-eof`: 入力の行と、入力の終わり (非対話の実行だけが送る)
 *
 * runner → 親 (どれも runnerId を持つ。run のメッセージは runId も持ち、親は今の run のものだけを扱う):
 * - `runner-ready`: runner が動き始めた。`crossOriginIsolated` が true でなければ親は実行しない (fail closed)
 * - `fatal`: Worker を作れない / Worker が落ちた
 * - `progress` / `ready` / `init-error`: Pyodide の読み込み
 * - `run-progress` / `stdout` / `stderr`: 進捗と出力 (stdout / stderr は UTF-8 を復号した断片)
 * - `started`: パッケージの準備が終わり、利用者のコードを実行し始めた (ここから時間を数える)
 * - `stdin-request`: 入力が無いので待ち始めた。`received` は runner がこの run で受け取った stdin の
 *   メッセージ (`stdin` / `stdin-eof`) の数で、親は送った数より少なければ「届く途中」とみなして待ちにしない
 * - `done`: 実行が終わった。`result` は式の値の文字列 (無ければ null)
 */

/** Pyodide の配信元 (indexURL)。runner の CSP の許可もここから作る。v0.27.0 は据え置き */
export const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

/** import から拾ったパッケージを micropip で入れるときの取得先 (PyPI の API と配布物)。runner の CSP の許可に使う */
export const PYPI_ORIGINS: readonly string[] = ['https://pypi.org', 'https://files.pythonhosted.org'];

/** 利用者のコードの実行時間の上限 (ミリ秒)。入力を待っている間は数えない */
export const PYTHON_TIMEOUT_MS = 60_000;

/** runner から受け取る 1 つの文字列フィールドの上限 (文字数)。Worker は出力を OUTPUT_CHUNK_CHARS ごとに分けて送る */
export const MAX_RUNNER_TEXT_CHARS = 65_536;

/** Worker が出力をまとめて送る単位 (文字数)。ADR-0041 の JS / TS の Worker と同じ 8 KiB */
export const OUTPUT_CHUNK_CHARS = 8_192;

export type PythonRunnerRequest =
  | { type: 'init' }
  | { type: 'run'; runId: number; code: string; packages: string[]; outputBudgetChars: number }
  | { type: 'stdin'; runId: number; text: string }
  | { type: 'stdin-eof'; runId: number };

export type PythonInitStage = 'sdk' | 'compiler' | 'runtime' | 'ready';

/** Executor が扱うメッセージ (runner 自体の準備と異常は PythonRunner が受ける) */
export type PythonExecMessage =
  | { type: 'progress'; stage: PythonInitStage; message: string; percentage?: number }
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'run-progress'; runId: number; message: string }
  | { type: 'stdout'; runId: number; text: string }
  | { type: 'stderr'; runId: number; text: string }
  | { type: 'started'; runId: number }
  | { type: 'stdin-request'; runId: number; received: number }
  | { type: 'done'; runId: number; success: boolean; error?: string; result: string | null };

export type PythonRunnerMessage =
  | { type: 'runner-ready'; crossOriginIsolated: boolean }
  | { type: 'fatal'; message: string }
  | PythonExecMessage;

export type PythonRunMessage = Extract<PythonExecMessage, { runId: number }>;

const STAGES = new Set<string>(['sdk', 'compiler', 'runtime', 'ready']);

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RUNNER_TEXT_CHARS;
}

function isRunId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * runner から受け取ったデータを検査して、この runner (`runnerId`) の正しい形のメッセージだけを返す。
 * 別の runner・未知の type・フィールドの型違い・長すぎる文字列・オブジェクトでないものは null。
 * 返すのは知っているフィールドだけを写した新しいオブジェクト (余計なフィールドを中へ通さない)
 */
export function parsePythonRunnerMessage(data: unknown, runnerId: string): PythonRunnerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runnerId !== 'string' || d.runnerId !== runnerId) return null;
  switch (d.type) {
    case 'runner-ready':
      return typeof d.crossOriginIsolated === 'boolean'
        ? { type: 'runner-ready', crossOriginIsolated: d.crossOriginIsolated }
        : null;
    case 'fatal':
      return isText(d.message) ? { type: 'fatal', message: d.message } : null;
    case 'progress': {
      if (typeof d.stage !== 'string' || !STAGES.has(d.stage) || !isText(d.message)) return null;
      const stage = d.stage as PythonInitStage;
      if (d.percentage === undefined) return { type: 'progress', stage, message: d.message };
      return typeof d.percentage === 'number' && Number.isFinite(d.percentage)
        ? { type: 'progress', stage, message: d.message, percentage: d.percentage }
        : null;
    }
    case 'ready':
      return { type: 'ready' };
    case 'init-error':
      return isText(d.error) ? { type: 'init-error', error: d.error } : null;
    case 'run-progress':
      return isRunId(d.runId) && isText(d.message) ? { type: 'run-progress', runId: d.runId, message: d.message } : null;
    case 'stdout':
    case 'stderr':
      return isRunId(d.runId) && isText(d.text) ? { type: d.type, runId: d.runId, text: d.text } : null;
    case 'started':
      return isRunId(d.runId) ? { type: 'started', runId: d.runId } : null;
    case 'stdin-request':
      return isRunId(d.runId) && typeof d.received === 'number' && Number.isSafeInteger(d.received) && d.received >= 0
        ? { type: 'stdin-request', runId: d.runId, received: d.received }
        : null;
    case 'done': {
      if (!isRunId(d.runId) || typeof d.success !== 'boolean') return null;
      if (d.result !== null && !isText(d.result)) return null;
      if (d.error !== undefined && !isText(d.error)) return null;
      return {
        type: 'done',
        runId: d.runId,
        success: d.success,
        result: d.result,
        ...(d.error !== undefined ? { error: d.error } : {}),
      };
    }
    default:
      return null;
  }
}

/** run に属するメッセージか (runId を持つ) */
export function isPythonRunMessage(message: PythonExecMessage): message is PythonRunMessage {
  return 'runId' in message;
}
