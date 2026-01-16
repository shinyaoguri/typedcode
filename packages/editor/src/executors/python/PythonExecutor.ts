/**
 * Python Language Executor
 *
 * Executes Python code in the browser using Pyodide (CPython compiled to WebAssembly).
 * Supports automatic package installation via micropip.
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

// Pyodide type definitions
interface PyodideInterface {
  runPythonAsync(code: string): Promise<unknown>;
  globals: {
    get(name: string): unknown;
    set(name: string, value: unknown): void;
  };
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

// Global declaration for loadPyodide
declare global {
  function loadPyodide(config?: {
    indexURL?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  }): Promise<PyodideInterface>;
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

const PYODIDE_CDN_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

// Python standard library modules (to exclude from micropip install)
const PYTHON_STDLIB_MODULES = new Set([
  'sys', 'os', 'math', 'json', 'random', 're', 'time', 'datetime',
  'collections', 'itertools', 'functools', 'typing', 'io', 'string',
  'pathlib', 'abc', 'copy', 'enum', 'dataclasses', 'contextlib',
  'operator', 'bisect', 'heapq', 'array', 'struct', 'codecs',
  'unicodedata', 'textwrap', 'difflib', 'pprint', 'reprlib',
  'calendar', 'locale', 'argparse', 'logging', 'warnings',
  'traceback', 'inspect', 'dis', 'pickle', 'shelve', 'sqlite3',
  'csv', 'html', 'xml', 'urllib', 'http', 'email', 'base64',
  'binascii', 'hashlib', 'hmac', 'secrets', 'threading', 'queue',
  'asyncio', 'concurrent', 'subprocess', 'sched', 'unittest', 'doctest',
  'numbers', 'decimal', 'fractions', 'statistics', 'cmath',
  'builtins', '__future__', 'types', 'weakref', 'gc',
  'tempfile', 'shutil', 'glob', 'fnmatch', 'linecache',
  'zipfile', 'tarfile', 'gzip', 'bz2', 'lzma', 'zlib',
  'configparser', 'netrc', 'plistlib',
  'socket', 'ssl', 'select', 'selectors', 'signal',
  'mmap', 'contextvars', 'token', 'keyword', 'tokenize', 'tabnanny',
  'pdb', 'profile', 'timeit', 'trace', 'code', 'codeop',
  'ast', 'symtable', 'compileall', 'py_compile', 'zipimport', 'pkgutil',
  'modulefinder', 'runpy', 'importlib',
  'platform', 'errno', 'ctypes', 'multiprocessing', 'atexit',
  'gettext', 'getopt', 'getpass', 'curses', 'readline', 'rlcompleter',
  'struct', 'codecs', 'unicodedata', 'stringprep',
  'cmd', 'shlex', 'wave', 'colorsys', 'imghdr', 'sndhdr', 'ossaudiodev',
  'cgi', 'cgitb', 'wsgiref', 'xmlrpc', 'ipaddress', 'ftplib', 'poplib',
  'imaplib', 'smtplib', 'smtpd', 'telnetlib', 'uuid', 'socketserver',
  'webbrowser', 'crypt', 'termios', 'tty', 'pty', 'fcntl', 'pipes',
  'posix', 'pwd', 'grp', 'spwd', 'resource', 'syslog', 'optparse',
  'fileinput', 'filecmp', 'stat', 'mailcap', 'mailbox', 'mimetypes',
  'encodings', 'quopri', 'uu', 'xdrlib',
  // Pyodide built-in packages
  'micropip', 'pyodide', 'js', 'pyodide_js',
]);

export class PythonExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'python',
    name: 'Python',
    fileExtension: '.py',
    monacoLanguage: 'python',
    defaultCode: DEFAULT_PYTHON_CODE,
  };

  private pyodide: PyodideInterface | null = null;
  private abortController: AbortController | null = null;
  private installedPackages: Set<string> = new Set();

  protected async _doInitialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void> {
    try {
      onProgress?.({
        stage: 'sdk',
        message: 'Loading Python runtime (this may take a while)...',
        percentage: 20,
      });

      // Dynamically load Pyodide script if not already loaded
      if (typeof loadPyodide === 'undefined') {
        await this.loadPyodideScript();
      }

      onProgress?.({
        stage: 'compiler',
        message: 'Initializing Python interpreter...',
        percentage: 50,
      });

      this.pyodide = await loadPyodide({
        indexURL: PYODIDE_CDN_URL,
      });

      onProgress?.({
        stage: 'ready',
        message: 'Python runtime ready!',
        percentage: 100,
      });
    } catch (error) {
      console.error('[PythonExecutor] Initialization failed:', error);
      throw new Error(`Failed to initialize Python: ${error}`);
    }
  }

  private async loadPyodideScript(): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${PYODIDE_CDN_URL}pyodide.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Pyodide script'));
      document.head.appendChild(script);
    });
  }

  /**
   * Parse import statements and install required packages via micropip
   */
  private async installRequiredPackages(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<void> {
    if (!this.pyodide) return;

    // Parse import statements
    const importRegex = /^\s*(?:import|from)\s+(\w+)/gm;
    const packages = new Set<string>();

    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const pkg = match[1];
      // Exclude standard library and already installed packages
      if (pkg && !PYTHON_STDLIB_MODULES.has(pkg) && !this.installedPackages.has(pkg)) {
        packages.add(pkg);
      }
    }

    if (packages.size === 0) return;

    const packageList = [...packages];
    callbacks.onProgress?.(`Installing packages: ${packageList.join(', ')}...`);

    try {
      const installCode = `
import micropip
await micropip.install([${packageList.map((p) => `'${p}'`).join(', ')}])
`;
      await this.pyodide.runPythonAsync(installCode);

      for (const pkg of packages) {
        this.installedPackages.add(pkg);
      }

      callbacks.onStdout(`Installed: ${packageList.join(', ')}\n`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      callbacks.onStderr(`Failed to install packages: ${errorMsg}\n`);
      // Continue execution even if package installation fails
    }
  }

  async run(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    if (!this._initialized || !this.pyodide) {
      throw new Error('PythonExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();
    this.abortController = new AbortController();

    let stdout = '';
    let stderr = '';

    try {
      // Install required packages if any
      await this.installRequiredPackages(code, callbacks);

      callbacks.onProgress?.('Running Python...');

      // Capture stdout/stderr
      this.pyodide.setStdout({
        batched: (text: string) => {
          stdout += text + '\n';
          callbacks.onStdout(text + '\n');
        },
      });

      this.pyodide.setStderr({
        batched: (text: string) => {
          stderr += text + '\n';
          callbacks.onStderr(text + '\n');
        },
      });

      // Execute with timeout
      const result = await this.executeWithTimeout(
        this.pyodide.runPythonAsync(code),
        60000 // 60 second timeout (Python can have heavy computations)
      );

      // Display return value if any
      if (result !== undefined && result !== null) {
        const resultStr = String(result);
        if (resultStr !== 'None') {
          callbacks.onStdout(`=> ${resultStr}\n`);
          stdout += `=> ${resultStr}\n`;
        }
      }

      return {
        success: true,
        exitCode: 0,
        stdout,
        stderr,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      callbacks.onStderr(errorMsg + '\n');
      stderr += errorMsg;

      return {
        success: false,
        exitCode: 1,
        stdout,
        stderr,
        error: errorMsg,
      };
    } finally {
      this.abortController = null;
    }
  }

  protected _onAbort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    console.log('[PythonExecutor] Abort requested');
    // Note: Full abort of Pyodide execution is not fully supported
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];

    // Parse Python traceback format
    // "  File "<exec>", line 5"
    // "    x = undefined_var"
    // "NameError: name 'undefined_var' is not defined"

    const lineRegex = /File "(?:<exec>|<stdin>|<string>)", line (\d+)/g;
    const errorTypeRegex = /^(\w+Error):\s*(.+)$/m;

    let lineMatch;
    while ((lineMatch = lineRegex.exec(stderr)) !== null) {
      if (!lineMatch[1]) continue;
      const line = parseInt(lineMatch[1], 10);
      const errorMatch = stderr.match(errorTypeRegex);
      const message = errorMatch
        ? `${errorMatch[1]}: ${errorMatch[2]}`
        : 'Python Error';

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
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Pyodide doesn't have a dispose method, so just clear the reference
    this.pyodide = null;
    this.installedPackages.clear();
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
