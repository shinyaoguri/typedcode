/**
 * Python Language Executor
 *
 * Executes Python code in the browser using Pyodide (CPython compiled to WebAssembly).
 * Supports automatic package installation via micropip.
 *
<<<<<<< HEAD
 * Pyodide は opaque origin の sandbox iframe の中の Worker (runner。PythonRunner.ts /
 * pythonRunnerDocument.ts) で動かす (#649 / #719)。実行コードから editor の IndexedDB (proof)・
 * localStorage・DOM に届かない。runner が cross-origin isolated でなければ実行しない (fail closed)。
 * メインスレッドはここで runner を作り、メッセージを中継するだけ。
 * - stdin: ターミナル (`CTerminal`) が line discipline (stdinLineDiscipline.ts) で行にした入力を、
 *   postMessage で runner へ送る。runner は自分の SharedArrayBuffer のチャネル (stdinChannelSource.ts) に
 *   書き、Worker は `Atomics.wait` で待つ。EOF (空の行の Ctrl+D・「入力終了」) は `stdin-eof` で渡す
 *   (#707。`input()` は EOFError になる)
 * - 停止とタイムアウト: runner を `terminate()` (iframe ごと除去) して捨てる。次の実行で初期化し直す
=======
 * Pyodide は専用の module Worker (`pythonWorker.ts`) で動かす (#649)。メインスレッドはここで
 * Worker を作り、メッセージを中継するだけ。
 * - stdin: ターミナル (`CTerminal`) が line discipline (stdinLineDiscipline.ts) で行にした入力を、
 *   SharedArrayBuffer のチャネル (stdinChannel.ts) で渡す。Worker は `Atomics.wait` で待つ
 *   (editor は cross-origin isolated なので SharedArrayBuffer を使える)。EOF (空の行の Ctrl+D・「入力終了」)
 *   はチャネルを閉じて渡す (#707。`input()` は EOFError になる)
 * - 停止とタイムアウト: Worker を `terminate()` して捨てる。次の実行で初期化し直す
>>>>>>> origin/main
 *   (`CodeExecutionController` の `!executor.isInitialized` の分岐)
 * - タイムアウトは入力を待っている間を数えない (pausableDeadline.ts)
 * - 出力の予算 (stdout + stderr の文字数。JS / TS の sandbox と同じ `OUTPUT_BUDGET_CHARS`) を超えたら、
 *   打ち切りを stderr に一度だけ出して runner を捨て、`error` で終える
 * - 非対話の実行 (#802。`run` の options.stdin): stdin の全体を送って閉じ、渡し切った後の
 *   読み込みに EOF を返す。ターミナルにはつながない。`showLastValue: false` で `=> 値` を出さない
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';
import { getExecutionLimits } from '../sandbox/limits.js';
import { outputLimitNotice } from '../sandbox/SandboxRunner.js';
import { PausableDeadline } from './pausableDeadline.js';
import { createPythonRunner, type PythonRunnerHandle } from './PythonRunner.js';
import {
  PYTHON_TIMEOUT_MS,
  isPythonRunMessage,
  type PythonExecMessage,
  type PythonRunMessage,
<<<<<<< HEAD
} from './pythonRunnerProtocol.js';
=======
  type PythonWorkerRequest,
} from './pythonWorkerProtocol.js';
import { StdinChannelWriter, createStdinBuffer } from './stdinChannel.js';

/** Worker の使う分だけの形 (テストでは偽物に差し替える) */
export interface PythonWorkerHandle {
  postMessage(message: PythonWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

function createPythonWorker(): PythonWorkerHandle {
  return new Worker(new URL('./pythonWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as PythonWorkerHandle;
}
>>>>>>> origin/main

// Python standard library modules (to exclude from micropip install)
const PYTHON_STDLIB_MODULES = new Set([
  'sys',
  'os',
  'math',
  'json',
  'random',
  're',
  'time',
  'datetime',
  'collections',
  'itertools',
  'functools',
  'typing',
  'io',
  'string',
  'pathlib',
  'abc',
  'copy',
  'enum',
  'dataclasses',
  'contextlib',
  'operator',
  'bisect',
  'heapq',
  'array',
  'struct',
  'codecs',
  'unicodedata',
  'textwrap',
  'difflib',
  'pprint',
  'reprlib',
  'calendar',
  'locale',
  'argparse',
  'logging',
  'warnings',
  'traceback',
  'inspect',
  'dis',
  'pickle',
  'shelve',
  'sqlite3',
  'csv',
  'html',
  'xml',
  'urllib',
  'http',
  'email',
  'base64',
  'binascii',
  'hashlib',
  'hmac',
  'secrets',
  'threading',
  'queue',
  'asyncio',
  'concurrent',
  'subprocess',
  'sched',
  'unittest',
  'doctest',
  'numbers',
  'decimal',
  'fractions',
  'statistics',
  'cmath',
  'builtins',
  '__future__',
  'types',
  'weakref',
  'gc',
  'tempfile',
  'shutil',
  'glob',
  'fnmatch',
  'linecache',
  'zipfile',
  'tarfile',
  'gzip',
  'bz2',
  'lzma',
  'zlib',
  'configparser',
  'netrc',
  'plistlib',
  'socket',
  'ssl',
  'select',
  'selectors',
  'signal',
  'mmap',
  'contextvars',
  'token',
  'keyword',
  'tokenize',
  'tabnanny',
  'pdb',
  'profile',
  'timeit',
  'trace',
  'code',
  'codeop',
  'ast',
  'symtable',
  'compileall',
  'py_compile',
  'zipimport',
  'pkgutil',
  'modulefinder',
  'runpy',
  'importlib',
  'platform',
  'errno',
  'ctypes',
  'multiprocessing',
  'atexit',
  'gettext',
  'getopt',
  'getpass',
  'curses',
  'readline',
  'rlcompleter',
  'struct',
  'codecs',
  'unicodedata',
  'stringprep',
  'cmd',
  'shlex',
  'wave',
  'colorsys',
  'imghdr',
  'sndhdr',
  'ossaudiodev',
  'cgi',
  'cgitb',
  'wsgiref',
  'xmlrpc',
  'ipaddress',
  'ftplib',
  'poplib',
  'imaplib',
  'smtplib',
  'smtpd',
  'telnetlib',
  'uuid',
  'socketserver',
  'webbrowser',
  'crypt',
  'termios',
  'tty',
  'pty',
  'fcntl',
  'pipes',
  'posix',
  'pwd',
  'grp',
  'spwd',
  'resource',
  'syslog',
  'optparse',
  'fileinput',
  'filecmp',
  'stat',
  'mailcap',
  'mailbox',
  'mimetypes',
  'encodings',
  'quopri',
  'uu',
  'xdrlib',
  // Pyodide built-in packages
  'micropip',
  'pyodide',
  'js',
  'pyodide_js',
]);

/** コードの import 文から、micropip で入れるパッケージを拾う (標準ライブラリは除く) */
export function findRequiredPackages(code: string): string[] {
  const importRegex = /^\s*(?:import|from)\s+(\w+)/gm;
  const packages = new Set<string>();
  for (const match of code.matchAll(importRegex)) {
    const pkg = match[1];
    if (pkg && !PYTHON_STDLIB_MODULES.has(pkg)) packages.add(pkg);
  }
  return [...packages];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PendingInit {
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress?: (progress: InitializationProgress) => void;
}

interface ActiveRun {
  runId: number;
  handle(message: PythonRunMessage): void;
  /** 停止 (Worker を捨てて aborted で終える) */
  abort(): void;
  /** Worker が落ちた (Worker を捨てて error で終える) */
  fail(error: string): void;
}

export class PythonExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'python',
    name: 'Python',
    fileExtension: '.py',
    monacoLanguage: 'python',
  };

  private worker: PythonRunnerHandle | null = null;
  private pendingInit: PendingInit | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;

  /**
   * @param createWorker runner の作り方 (テストで偽物に差し替える)
   * @param timeoutMs 実行時間の上限 (入力を待っている間は数えない)
   * @param outputBudgetChars stdout + stderr の合計文字数の上限 (run ごとに読む。E2E は dev 限定の上書きで縮める)
   */
  constructor(
    private readonly createWorker: () => PythonRunnerHandle = () => createPythonRunner(),
    private readonly timeoutMs: number = PYTHON_TIMEOUT_MS,
    private readonly outputBudgetChars: () => number = () => getExecutionLimits().outputBudgetChars
  ) {
    super();
  }

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (message) => this.handleMessage(worker, message);
    worker.onerror = (error) => this.handleWorkerError(worker, error);
    try {
      await new Promise<void>((resolve, reject) => {
        this.pendingInit = { resolve, reject, ...(onProgress ? { onProgress } : {}) };
        worker.postMessage({ type: 'init' });
      });
    } catch (error) {
      console.error('[PythonExecutor] Initialization failed:', error);
      this.discardWorker();
      throw new Error(`Failed to initialize Python: ${errorMessage(error)}`);
    } finally {
      this.pendingInit = null;
    }
  }

  private handleMessage(worker: PythonRunnerHandle, data: PythonExecMessage): void {
    // 捨てた runner の遅れたメッセージは扱わない
    if (worker !== this.worker) return;
    if (isPythonRunMessage(data)) {
      // 今の run のものだけを扱う
      if (this.activeRun?.runId === data.runId) this.activeRun.handle(data);
      return;
    }
    switch (data.type) {
      case 'progress':
        this.pendingInit?.onProgress?.({ stage: data.stage, message: data.message, percentage: data.percentage });
        return;
      case 'ready':
        this.pendingInit?.resolve();
        return;
      case 'init-error':
        this.pendingInit?.reject(new Error(data.error));
        return;
    }
  }

  private handleWorkerError(worker: PythonRunnerHandle, error: string): void {
    if (worker !== this.worker) return;
    if (this.pendingInit) this.pendingInit.reject(new Error(error));
    else if (this.activeRun) this.activeRun.fail(error);
    // どの run にも属さない異常 (実行の合間に Worker が落ちた) でも、次の実行で作り直す
    else this.discardWorker();
  }

  /** runner を止めて捨てる。次の実行で初期化し直す (micropip で入れたパッケージも一緒に消える) */
  private discardWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this._initialized = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }

  async run(code: string, callbacks: ExecutionCallbacks, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const showLastValue = options.showLastValue ?? true;
    const worker = this.worker;
    if (!this._initialized || !worker) {
      throw new Error('PythonExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();
    const runId = ++this.runSeq;
<<<<<<< HEAD
    const budget = this.outputBudgetChars();
=======
    const stdinBuffer = createStdinBuffer();
    const channel = new StdinChannelWriter(stdinBuffer);
>>>>>>> origin/main

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      /** runner が入力を求めていて、まだ渡していない */
      let awaitingInput = false;
      /** この run で runner へ送った stdin のメッセージの数 (stdin-request の received と比べる) */
      let sent = 0;
      /** 受け取った出力の文字数 (stdout + stderr) */
      let received = 0;

      const finish = (result: Omit<ExecutionResult, 'stdout' | 'stderr'>, discard: boolean): void => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        if (this.activeRun?.runId === runId) this.activeRun = null;
        if (discard) this.discardWorker();
        resolve({ ...result, stdout, stderr });
      };
      const stop = (outcome: 'aborted' | 'timeout' | 'error', error?: string): void => {
        finish(
          {
            success: false,
            exitCode: 1,
            outcome,
            ...(outcome === 'timeout' ? { timeoutMs: this.timeoutMs } : {}),
            ...(error !== undefined ? { error } : {}),
          },
          true
        );
      };
      const deadline = new PausableDeadline(this.timeoutMs, () => stop('timeout'));

      // 入力を runner へ送る。runner はそれを貯め、Worker が求めたら渡す
      const sendInput = (request: { type: 'stdin'; text: string } | { type: 'stdin-eof' }): void => {
        sent++;
        worker.postMessage({ ...request, runId });
        if (awaitingInput) {
          awaitingInput = false;
          deadline.resume();
        }
      };

      // 出力を予算の内側だけ渡す。超えたら打ち切りを一度だけ出して runner ごと止める (ADR-0041 と同じ)
      const deliver = (stream: 'stdout' | 'stderr', text: string): void => {
        const room = Math.max(0, budget - received);
        received += text.length;
        const part = text.length > room ? text.slice(0, room) : text;
        if (part.length > 0) {
          if (stream === 'stdout') {
            stdout += part;
            callbacks.onStdout(part);
          } else {
            stderr += part;
            callbacks.onStderr(part);
          }
        }
        if (received > budget) {
          const notice = outputLimitNotice(budget);
          stderr += notice;
          callbacks.onStderr(notice);
          stop('error', 'Output limit exceeded');
        }
      };

      this.activeRun = {
        runId,
        abort: () => stop('aborted'),
        fail: (error) => stop('error', error),
        handle: (message) => {
          switch (message.type) {
            case 'run-progress':
              callbacks.onProgress?.(message.message);
              return;
            case 'stdout':
            case 'stderr':
              deliver(message.type, message.text);
              return;
            case 'started':
              callbacks.onProgress?.('Running Python...');
              deadline.resume();
              callbacks.onProgramStart?.();
              return;
            case 'stdin-request':
              // runner は貯めた入力が無いときだけ求めてくる。送った入力がまだ届いていない (received < sent)
              // なら、届けば runner が渡すので待ちにしない。そうでなければ、行が確定するまで時間を数えない
              if (message.received >= sent) {
                awaitingInput = true;
                deadline.pause();
              }
              return;
            case 'done': {
              if (message.result !== null && showLastValue) {
                const text = `=> ${message.result}\n`;
                stdout += text;
                callbacks.onStdout(text);
              }
              if (!message.success && message.error !== undefined) {
                callbacks.onStderr(`${message.error}\n`);
                stderr += message.error;
              }
              finish(
                {
                  success: message.success,
                  exitCode: message.success ? 0 : 1,
                  ...(message.error !== undefined ? { error: message.error } : {}),
                },
                false
              );
              return;
            }
          }
        },
      };

<<<<<<< HEAD
      worker.postMessage({
        type: 'run',
        runId,
        code,
        packages: findRequiredPackages(code),
        outputBudgetChars: budget,
      });
=======
      if (options.stdin !== undefined) {
        // 非対話の実行 (#802): 全体を先に積んで閉じる (渡し切った後の読み込みは EOF)。
        // ターミナルにはつながず、エコーもしない (line discipline を通さない)
        channel.push(options.stdin);
        channel.close();
      } else {
        // ターミナルの入力は C と同じ connectStdin の経路で受ける (#707)。エコーと行の編集はターミナルの
        // line discipline がしていて、ここには確定した行と EOF (空の行の Ctrl+D・「入力終了」) だけが来る
        callbacks.onStdinReady?.({
          writeLine: (line) => {
            if (settled) return;
            channel.push(line);
            deliverInput();
          },
          close: () => {
            if (settled) return;
            channel.close();
            deliverInput();
          },
        });
      }
>>>>>>> origin/main

      if (options.stdin !== undefined) {
        // 非対話の実行 (#802): 全体を先に送って閉じる (渡し切った後の読み込みは EOF)。
        // ターミナルにはつながず、エコーもしない (line discipline を通さない)
        if (options.stdin.length > 0) sendInput({ type: 'stdin', text: options.stdin });
        sendInput({ type: 'stdin-eof' });
      } else {
        // ターミナルの入力は C と同じ connectStdin の経路で受ける (#707)。エコーと行の編集はターミナルの
        // line discipline がしていて、ここには確定した行と EOF (空の行の Ctrl+D・「入力終了」) だけが来る
        let closed = false;
        callbacks.onStdinReady?.({
          writeLine: (line) => {
            if (settled || closed) return;
            sendInput({ type: 'stdin', text: line });
          },
          close: () => {
            if (settled || closed) return;
            closed = true;
            sendInput({ type: 'stdin-eof' });
          },
        });
      }
    });
  }

  protected _onAbort(): void {
    // 実行中なら Worker ごと止める (同期のループも止まる)。初期化中は止めず、読み込みを続ける
    this.activeRun?.abort();
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];

    // Parse Python traceback format
    // "  File "<exec>", line 5"
    // "    x = undefined_var"
    // "NameError: name 'undefined_var' is not defined"

    const lineRegex = /File "(?:<exec>|<stdin>|<string>)", line (\d+)/g;
    const errorTypeRegex = /^(\w+Error):\s*(.+)$/m;

    for (const lineMatch of stderr.matchAll(lineRegex)) {
      if (!lineMatch[1]) continue;
      const line = parseInt(lineMatch[1], 10);
      const errorMatch = stderr.match(errorTypeRegex);
      const message = errorMatch ? `${errorMatch[1]}: ${errorMatch[2]}` : 'Python Error';

      errors.push({
        line,
        column: 0, // Python doesn't provide column info
        severity: 'error',
        message,
      });
    }

    return errors;
  }

  override dispose(): void {
    super.dispose();
    this.activeRun?.abort();
    this.pendingInit?.reject(new Error('PythonExecutor disposed'));
    this.discardWorker();
  }
}

// Singleton instance
let executorInstance: PythonExecutor | null = null;

/**
 * Get the singleton PythonExecutor instance
 */
export function getPythonExecutor(): PythonExecutor {
  if (!executorInstance) {
    executorInstance = new PythonExecutor();
  }
  return executorInstance;
}
