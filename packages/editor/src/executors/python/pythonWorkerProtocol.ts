/**
 * Python の Worker (`pythonWorker.ts`) とメイン (`PythonExecutor.ts`) の間のメッセージ (#649)。
 *
 * メイン → Worker:
 * - `init`: Pyodide を読み込む。`progress` を何度か返し、`ready` か `init-error` で終わる
 * - `run`: コードを実行する。stdin のチャネル (stdinChannel.ts) の SharedArrayBuffer を渡す
 *
 * Worker → メイン (run のメッセージはすべて runId を持ち、メインは今の run のものだけを扱う):
 * - `run-progress` / `stdout` / `stderr`: 進捗と出力 (stdout / stderr は UTF-8 を復号した断片)
 * - `started`: パッケージの準備が終わり、利用者のコードを実行し始めた (ここから時間を数える)
 * - `stdin-request`: stdin を読もうとしてチャネルが空なので、これから `Atomics.wait` で待つ
 * - `done`: 実行が終わった。`result` は式の値の文字列 (無ければ null)
 */

/** Pyodide の配信元。v0.27.0 は据え置き */
export const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

/** 利用者のコードの実行時間の上限 (ミリ秒)。入力を待っている間は数えない */
export const PYTHON_TIMEOUT_MS = 60_000;

export type PythonWorkerRequest =
  | { type: 'init'; indexURL: string }
  | { type: 'run'; runId: number; code: string; packages: string[]; stdinBuffer: SharedArrayBuffer };

export type PythonInitStage = 'sdk' | 'compiler' | 'runtime' | 'ready';

export type PythonWorkerMessage =
  | { type: 'progress'; stage: PythonInitStage; message: string; percentage?: number }
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'run-progress'; runId: number; message: string }
  | { type: 'stdout'; runId: number; text: string }
  | { type: 'stderr'; runId: number; text: string }
  | { type: 'started'; runId: number }
  | { type: 'stdin-request'; runId: number }
  | { type: 'done'; runId: number; success: boolean; error?: string; result: string | null };

export type PythonRunMessage = Extract<PythonWorkerMessage, { runId: number }>;

const KNOWN_TYPES = new Set<string>([
  'progress',
  'ready',
  'init-error',
  'run-progress',
  'stdout',
  'stderr',
  'started',
  'stdin-request',
  'done',
]);

/** Worker からのメッセージの形を最低限確かめる (同じ origin の自前の Worker なので、型の取り違えを防ぐ程度) */
export function isPythonWorkerMessage(value: unknown): value is PythonWorkerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && KNOWN_TYPES.has(type);
}

/** run に属するメッセージか (runId を持つ) */
export function isPythonRunMessage(message: PythonWorkerMessage): message is PythonRunMessage {
  return typeof (message as { runId?: unknown }).runId === 'number';
}
