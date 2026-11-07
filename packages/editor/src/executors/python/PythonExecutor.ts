/**
 * Python Language Executor
 *
 * Executes Python code in the browser using Pyodide (CPython compiled to WebAssembly).
 * Supports automatic package installation via micropip.
 *
 * Pyodide は専用の module Worker (`pythonWorker.ts`) で動かす (#649)。メインスレッドはここで
 * Worker を作り、メッセージを中継するだけ。
 * - stdin: ターミナルの入力を line discipline (stdinLineDiscipline.ts) で行にして、
 *   SharedArrayBuffer のチャネル (stdinChannel.ts) で渡す。Worker は `Atomics.wait` で待つ
 *   (editor は cross-origin isolated なので SharedArrayBuffer を使える)
 * - 停止とタイムアウト: Worker を `terminate()` して捨てる。次の実行で初期化し直す
 *   (`CodeExecutionController` の `!executor.isInitialized` の分岐)
 * - タイムアウトは入力を待っている間を数えない (pausableDeadline.ts)
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';
import { PausableDeadline } from './pausableDeadline.js';
import {
  PYODIDE_CDN_URL,
  PYTHON_TIMEOUT_MS,
  isPythonRunMessage,
  isPythonWorkerMessage,
  type PythonRunMessage,
  type PythonWorkerRequest,
} from './pythonWorkerProtocol.js';
import { StdinChannelWriter, createStdinBuffer } from './stdinChannel.js';
import { StdinLineDiscipline } from '../../terminal/stdinLineDiscipline.js';

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

const DEFAULT_PYTHON_CODE = `# Welcome to Python!
print("Hello, World!")

# List operations
numbers = [1, 2, 3, 4, 5]
squared = [x ** 2 for x in numbers]
print(f"Squared: {squared}")

# Function definition
def greet(name: str) -> str:
    return f"Hello, {name}!"

print(greet("Python"))
`;

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
    defaultCode: DEFAULT_PYTHON_CODE,
  };

  private worker: PythonWorkerHandle | null = null;
  private pendingInit: PendingInit | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;

  /**
   * @param createWorker Worker の作り方 (テストで偽物に差し替える)
   * @param timeoutMs 実行時間の上限 (入力を待っている間は数えない)
   */
  constructor(
    private readonly createWorker: () => PythonWorkerHandle = createPythonWorker,
    private readonly timeoutMs: number = PYTHON_TIMEOUT_MS
  ) {
    super();
  }

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => this.handleWorkerError(worker, event);
    try {
      await new Promise<void>((resolve, reject) => {
        this.pendingInit = { resolve, reject, ...(onProgress ? { onProgress } : {}) };
        worker.postMessage({ type: 'init', indexURL: PYODIDE_CDN_URL });
      });
    } catch (error) {
      console.error('[PythonExecutor] Initialization failed:', error);
      this.discardWorker();
      throw new Error(`Failed to initialize Python: ${errorMessage(error)}`);
    } finally {
      this.pendingInit = null;
    }
  }

  private handleMessage(worker: PythonWorkerHandle, data: unknown): void {
    // 捨てた Worker の遅れたメッセージは扱わない
    if (worker !== this.worker || !isPythonWorkerMessage(data)) return;
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

  private handleWorkerError(worker: PythonWorkerHandle, event: Event): void {
    if (worker !== this.worker) return;
    event.preventDefault();
    const message = (event as ErrorEvent).message || 'Python worker failed to start';
    if (this.pendingInit) this.pendingInit.reject(new Error(message));
    else this.activeRun?.fail(message);
  }

  /** Worker を止めて捨てる。次の実行で初期化し直す (micropip で入れたパッケージも Worker と一緒に消える) */
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

  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    const worker = this.worker;
    if (!this._initialized || !worker) {
      throw new Error('PythonExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();
    const runId = ++this.runSeq;
    const stdinBuffer = createStdinBuffer();
    const channel = new StdinChannelWriter(stdinBuffer);
    const discipline = new StdinLineDiscipline();
    const inputDecoder = new TextDecoder();

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      /** Worker が入力を求めていて、まだ渡していない */
      let awaitingInput = false;

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

      const deliverInput = (): void => {
        if (awaitingInput && channel.offer()) {
          awaitingInput = false;
          deadline.resume();
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
              stdout += message.text;
              callbacks.onStdout(message.text);
              return;
            case 'stderr':
              stderr += message.text;
              callbacks.onStderr(message.text);
              return;
            case 'started':
              callbacks.onProgress?.('Running Python...');
              deadline.resume();
              return;
            case 'stdin-request':
              // 先打ちの行があればすぐ渡す。無ければ、行が確定するまで時間を数えない
              if (!channel.offer()) {
                awaitingInput = true;
                deadline.pause();
              }
              return;
            case 'done': {
              if (message.result !== null) {
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

      // ターミナルの入力は C と同じ connectStdin の経路で受ける (行の記録 terminalInput もそこにある)
      callbacks.onStdinReady?.(
        new WritableStream<Uint8Array>({
          write: (chunk) => {
            if (settled) return;
            const { echo, lines } = discipline.feed(inputDecoder.decode(chunk, { stream: true }));
            if (echo) callbacks.onStdout(echo);
            for (const line of lines) channel.push(line);
            deliverInput();
          },
        })
      );

      worker.postMessage({ type: 'run', runId, code, packages: findRequiredPackages(code), stdinBuffer });
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
