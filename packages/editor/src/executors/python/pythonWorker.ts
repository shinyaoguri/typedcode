/**
 * Python (Pyodide) を動かす専用の module Worker (#649)。
 *
 * メインスレッドで Pyodide を動かすと、`input()` がブラウザの `prompt()` になり (stdin のコールバックは
 * 同期で値を返す必要があり、メインスレッドではターミナルの非同期の入力を待てない)、計算中はエディタが
 * 固まり、停止もできない。Worker なら stdin を `Atomics.wait` で待てて、停止はメインが `terminate()` で行う。
 *
 * メッセージの形は pythonWorkerProtocol.ts。stdin は stdinChannel.ts のチャネルで受ける。
 */

import type { PythonWorkerMessage, PythonWorkerRequest } from './pythonWorkerProtocol.js';
import { StdinChannelReader } from './stdinChannel.js';

// Pyodide の型 (使う分だけの最小限)
interface PyodideInterface {
  runPythonAsync(code: string): Promise<unknown>;
  runPython(code: string): unknown;
  loadPackage(names: string | string[]): Promise<unknown>;
  setStdout(options: { write: (buffer: Uint8Array) => number }): void;
  setStderr(options: { write: (buffer: Uint8Array) => number }): void;
  setStdin(options: { read: (buffer: Uint8Array) => number }): void;
}

interface PyodideModule {
  loadPyodide(config: { indexURL: string }): Promise<PyodideInterface>;
}

interface WorkerScope {
  postMessage(message: PythonWorkerMessage): void;
  onmessage: ((event: MessageEvent<PythonWorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: PythonWorkerMessage): void => scope.postMessage(message);

let pyodide: PyodideInterface | null = null;
/** この Worker で micropip が入れたパッケージ (Worker を捨てると一緒に消える) */
const installedPackages = new Set<string>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function init(indexURL: string): Promise<void> {
  try {
    post({
      type: 'progress',
      stage: 'sdk',
      message: 'Loading Python runtime (this may take a while)...',
      percentage: 20,
    });
    const url = `${indexURL}pyodide.mjs`;
    const module = (await import(/* @vite-ignore */ url)) as PyodideModule;
    post({ type: 'progress', stage: 'compiler', message: 'Initializing Python interpreter...', percentage: 50 });
    pyodide = await module.loadPyodide({ indexURL });
    post({ type: 'progress', stage: 'ready', message: 'Python runtime ready!', percentage: 100 });
    post({ type: 'ready' });
  } catch (error) {
    post({ type: 'init-error', error: errorMessage(error) });
  }
}

/** stdout / stderr の書き手。UTF-8 を文字の途中で切らずに復号して、書かれるたびに送る */
function streamWriter(runId: number, type: 'stdout' | 'stderr') {
  const decoder = new TextDecoder();
  return {
    write(buffer: Uint8Array): number {
      const text = decoder.decode(buffer, { stream: true });
      if (text) post({ type, runId, text });
      return buffer.length;
    },
    flush(): void {
      const text = decoder.decode();
      if (text) post({ type, runId, text });
    },
  };
}

async function installPackages(py: PyodideInterface, runId: number, requested: string[]): Promise<void> {
  const packages = requested.filter((p) => !installedPackages.has(p));
  if (packages.length === 0) return;
  post({ type: 'run-progress', runId, message: `Installing packages: ${packages.join(', ')}...` });
  try {
    await py.loadPackage('micropip');
    await py.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(packages)})\n`);
    for (const p of packages) installedPackages.add(p);
    post({ type: 'stdout', runId, text: `Installed: ${packages.join(', ')}\n` });
  } catch (error) {
    // インストールに失敗しても実行は続ける (import の行で利用者に分かる形で落ちる)
    post({ type: 'stderr', runId, text: `Failed to install packages: ${errorMessage(error)}\n` });
  }
}

function displayValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  // PyProxy は使い終わったら解放する
  const proxy = value as { destroy?: () => void };
  if (typeof proxy.destroy === 'function') proxy.destroy();
  return text === 'None' ? null : text;
}

async function run(request: Extract<PythonWorkerRequest, { type: 'run' }>): Promise<void> {
  const { runId } = request;
  const py = pyodide;
  if (!py) {
    post({ type: 'done', runId, success: false, error: 'Python runtime is not initialized', result: null });
    return;
  }

  const stdout = streamWriter(runId, 'stdout');
  const stderr = streamWriter(runId, 'stderr');
  const reader = new StdinChannelReader(request.stdinBuffer);
  /** チャネルから受け取って、まだ Python に渡していないバイト列 */
  let pending: Uint8Array = new Uint8Array(0);

  // stdout は書かれるたびに送る (`batched` は改行まで溜めるので、`input("名前: ")` の案内文が出ない)
  py.setStdout({ write: (buffer) => stdout.write(buffer) });
  py.setStderr({ write: (buffer) => stderr.write(buffer) });
  // isatty は付けない: stdin と stdout が tty でなければ、input() は案内文を stdout に書いて flush してから読む
  py.setStdin({
    read: (buffer) => {
      if (pending.length === 0) {
        pending = reader.read(() => post({ type: 'stdin-request', runId }));
      }
      const n = Math.min(buffer.length, pending.length);
      buffer.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return n;
    },
  });

  await installPackages(py, runId, request.packages);
  post({ type: 'started', runId });

  let success = true;
  let error: string | undefined;
  let result: string | null = null;
  try {
    result = displayValue(await py.runPythonAsync(request.code));
  } catch (e) {
    success = false;
    error = errorMessage(e);
  }

  // Python 側に溜まった出力と、復号の途中のバイトを出し切ってから終わりを知らせる
  try {
    py.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()\n');
  } catch {
    // 出し切れなくても結果は返す
  }
  stdout.flush();
  stderr.flush();
  post({ type: 'done', runId, success, ...(error !== undefined ? { error } : {}), result });
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'init') void init(request.indexURL);
  else if (request.type === 'run') void run(request);
};
