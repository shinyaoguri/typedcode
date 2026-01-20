/**
 * C Language Executor
 *
 * Compiles and executes C code in the browser using Wasmer SDK and Clang.
 */

import { init, Wasmer, Directory, type SpawnOptions } from '@wasmer/sdk';
import wasmUrl from '@wasmer/sdk/wasm?url';

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

// Re-export ParsedError for backward compatibility
export type { ParsedError } from '../interfaces/ILanguageExecutor.js';

const DEFAULT_C_CODE = `#include <stdio.h>

int main() {
    printf("Hello, World!\\n");
    return 0;
}
`;

/**
 * Error patterns that indicate runtime corruption requiring reset
 */
/**
 * Clang compiler version hosted on Cloudflare R2
 * Update this when uploading a new version via scripts/update-clang.sh
 */
const CLANG_VERSION = '0.1.1';

const RUNTIME_ERROR_PATTERNS = [
  'runtimeerror',
  'memory access out of bounds',
  'unreachable executed',
  'call stack exhausted',
  'integer overflow',
  'integer divide by zero',
  'stack overflow',
  'out of memory',
  'null function',
  'function signature mismatch',
  'table index is out of bounds',
  'invalid conversion to integer',
  'indirect call type mismatch',
  'wasm trap',
  'aborted',
];

/** Options for compiling with different settings */
export interface CompileOptions {
  sourceFile?: string;
  compileArgs?: string[];
}

export class CExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'c',
    name: 'C',
    fileExtension: '.c',
    monacoLanguage: 'c',
    defaultCode: DEFAULT_C_CODE,
    icon: 'c-icon',
  };

  protected clangPkg: Wasmer | null = null;

  /** Currently running instance (for abort support) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private runningInstance: any = null;

  /** Stdin stream of the running instance (for sending SIGINT) */
  private runningStdin: WritableStream<Uint8Array> | null = null;

  /** Callbacks for the current execution (for abort messaging) */
  private currentCallbacks: ExecutionCallbacks | null = null;

  protected async _doInitialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void> {
    try {
      onProgress?.({
        stage: 'sdk',
        message: 'Initializing Wasmer SDK...',
        percentage: 10,
      });

      await init({ module: wasmUrl });

      onProgress?.({
        stage: 'compiler',
        message: 'Downloading C compiler...',
        percentage: 30,
      });

      // Load clang package from Cloudflare R2 to avoid:
      // 1. CORS issues with Wasmer CDN
      // 2. Cloudflare Pages 25MB file size limit
      // Version in filename ensures cache busting when updated
      const clangWebcUrl = `https://assets.typedcode.dev/wasm/clang-${CLANG_VERSION}.webc`;
      const response = await fetch(clangWebcUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch clang.webc: ${response.status} ${response.statusText}`);
      }
      const clangBinary = new Uint8Array(await response.arrayBuffer());
      this.clangPkg = await Wasmer.fromFile(clangBinary);

      onProgress?.({
        stage: 'ready',
        message: 'C compiler ready!',
        percentage: 100,
      });
    } catch (error) {
      console.error('[CExecutor] Initialization failed:', error);
      throw new Error(`Failed to initialize C compiler: ${error}`);
    }
  }

  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    return this.runWithOptions(code, callbacks, {});
  }

  /**
   * Run code with custom compile options (for subclasses like CppExecutor)
   */
  protected async runWithOptions(
    code: string,
    callbacks: ExecutionCallbacks,
    options: CompileOptions
  ): Promise<ExecutionResult> {
    // Auto-reset if runtime was corrupted
    if (this._runtimeCorrupted) {
      console.log('[CExecutor] Runtime was corrupted, performing auto-reset...');
      callbacks.onProgress?.('Resetting runtime due to previous error...');
      await this.resetRuntime();
    }

    if (!this._initialized || !this.clangPkg) {
      throw new Error('Executor not initialized. Call initialize() first.');
    }

    const sourceFile = options.sourceFile ?? 'main.c';
    const extraArgs = options.compileArgs ?? [];

    this.resetAbort();

    try {
      callbacks.onProgress?.('Compiling...');

      // Inject unbuffered stdout setup at the beginning of the code
      // This ensures stdout behaves like a local terminal (line-buffered → unbuffered)
      const preamble = `#include <stdio.h>
/* TypedCode: Force unbuffered stdout for immediate output */
__attribute__((constructor))
static void __typedcode_init_stdout(void) {
    setvbuf(stdout, (char *)0, _IONBF, 0);
}
`;
      const modifiedCode = preamble + code;

      // Create virtual filesystem with source file
      const project = new Directory();
      await project.writeFile(sourceFile, modifiedCode);

      const entrypoint = this.clangPkg.entrypoint;
      if (!entrypoint) {
        throw new Error('Clang package has no entrypoint');
      }

      // Compile the code
      const compileOptions: SpawnOptions = {
        args: [
          `/project/${sourceFile}`,
          '-o', '/project/main.wasm',
          '-target', 'wasm32-wasi',
          '-O2',
          ...extraArgs,
        ],
        mount: {
          '/project': project,
        },
      };

      const compileInstance = await entrypoint.run(compileOptions);
      const compileResult = await compileInstance.wait();

      if (compileResult.code !== 0) {
        // Compilation failed
        const stderr = compileResult.stderr;
        callbacks.onStderr(stderr);

        return {
          success: false,
          exitCode: compileResult.code,
          stdout: compileResult.stdout,
          stderr: stderr,
          error: 'Compilation failed',
        };
      }

      callbacks.onProgress?.('Running...');

      // Read the compiled WASM binary
      const wasmBinary = await project.readFile('main.wasm');

      // Load and run the compiled program
      const program = await Wasmer.fromFile(wasmBinary);
      const programEntrypoint = program.entrypoint;
      if (!programEntrypoint) {
        throw new Error('Compiled program has no entrypoint');
      }

      // Start the program
      const runInstance = await programEntrypoint.run();
      this.runningInstance = runInstance;
      this.currentCallbacks = callbacks;

      const decoder = new TextDecoder();

      // Connect stdout using pipeTo() for direct streaming
      // Keep the promise to ensure all output is flushed before returning
      const stdoutPromise = runInstance.stdout.pipeTo(
        new WritableStream({
          write: (chunk) => {
            callbacks.onStdout(decoder.decode(chunk));
          },
        })
      ).catch(() => {
        // Ignore pipe errors (e.g., when program ends)
      });

      // Connect stderr using pipeTo() for direct streaming
      const stderrPromise = runInstance.stderr.pipeTo(
        new WritableStream({
          write: (chunk) => {
            callbacks.onStderr(decoder.decode(chunk));
          },
        })
      ).catch(() => {
        // Ignore pipe errors
      });

      // Notify caller that stdin is ready for connection
      const stdinStream = runInstance.stdin;
      if (stdinStream) {
        this.runningStdin = stdinStream;
        callbacks.onStdinReady?.(stdinStream);
      }

      // Wait for the program to finish
      let runResult;
      try {
        runResult = await runInstance.wait();
      } finally {
        this.runningInstance = null;
        this.runningStdin = null;
        this.currentCallbacks = null;
      }

      // Wait for output streams to flush with a timeout
      // pipeTo() may hang if the stream doesn't close properly
      const flushTimeout = new Promise<void>((resolve) => setTimeout(resolve, 100));
      await Promise.race([
        Promise.all([stdoutPromise, stderrPromise]),
        flushTimeout,
      ]);

      return {
        success: runResult.code === 0,
        exitCode: runResult.code,
        stdout: '', // Already streamed via callbacks
        stderr: '', // Already streamed via callbacks
      };
    } catch (error) {
      console.error('[CExecutor] Execution error:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if this is a runtime corruption error
      if (this.isRuntimeCorruptionError(error)) {
        console.warn('[CExecutor] Runtime corruption detected, marking for reset');
        this.markRuntimeCorrupted();

        // Provide user-friendly error message for common runtime errors
        const userMessage = this.getRuntimeErrorMessage(errorMsg);
        callbacks.onStderr(`Runtime Error: ${userMessage}\n`);
      } else {
        callbacks.onStderr(`Error: ${errorMsg}\n`);
      }

      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: errorMsg,
        error: errorMsg,
      };
    }
  }

  protected _onAbort(): void {
    console.log('[CExecutor] Abort requested');
    if (this.runningInstance) {
      // Try to send SIGINT (Ctrl+C) via stdin
      // ASCII 3 (ETX) is the character sent when Ctrl+C is pressed
      if (this.runningStdin) {
        this.sendSigint().catch((error) => {
          console.error('[CExecutor] Failed to send SIGINT:', error);
        });
      }

      // Notify user that the program cannot be stopped immediately
      this.currentCallbacks?.onStderr(
        '\n[System] Program stop requested. If the program does not stop, please reload the page.\n'
      );

      // Mark runtime for reset as a fallback
      // Programs that don't handle SIGINT will continue running,
      // but the runtime will be reset on the next execution
      this.markRuntimeCorrupted();
      this.runningInstance = null;
      this.runningStdin = null;
      this.currentCallbacks = null;
      console.log('[CExecutor] SIGINT sent, runtime marked for reset');
    }
  }

  /**
   * Send SIGINT (Ctrl+C) to the running program via stdin
   */
  private async sendSigint(): Promise<void> {
    if (!this.runningStdin) return;

    try {
      const writer = this.runningStdin.getWriter();
      // ASCII 3 (ETX) = Ctrl+C
      await writer.write(new Uint8Array([3]));
      writer.releaseLock();
    } catch {
      // Stream may already be closed
    }
  }

  /**
   * Check if an error indicates runtime corruption
   */
  private isRuntimeCorruptionError(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const lowerMsg = errorMsg.toLowerCase();
    return RUNTIME_ERROR_PATTERNS.some(pattern => lowerMsg.includes(pattern));
  }

  /**
   * Get user-friendly error message for runtime errors
   */
  private getRuntimeErrorMessage(errorMsg: string): string {
    const lowerMsg = errorMsg.toLowerCase();

    if (lowerMsg.includes('unreachable')) {
      return 'Program crashed (likely null pointer dereference or invalid memory access)';
    }
    if (lowerMsg.includes('memory access out of bounds')) {
      return 'Memory access out of bounds (array index out of range or invalid pointer)';
    }
    if (lowerMsg.includes('stack overflow')) {
      return 'Stack overflow (possibly infinite recursion)';
    }
    if (lowerMsg.includes('integer divide by zero')) {
      return 'Division by zero';
    }
    if (lowerMsg.includes('integer overflow')) {
      return 'Integer overflow';
    }
    if (lowerMsg.includes('out of memory')) {
      return 'Out of memory';
    }
    if (lowerMsg.includes('call stack exhausted')) {
      return 'Call stack exhausted (too deep recursion)';
    }

    return errorMsg;
  }

  /**
   * Reset the Wasmer runtime to a clean state
   */
  override async resetRuntime(): Promise<void> {
    console.log('[CExecutor] Resetting Wasmer runtime...');
    this.clangPkg = null;
    await super.resetRuntime();
    console.log('[CExecutor] Runtime reset complete');
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // clang error format: "filename:line:column: severity: message"
    // Matches .c, .cpp, .cc, .cxx files
    const regex = /(?:<stdin>|main\.c(?:pp)?|[\w.]+\.(?:c|cpp|cc|cxx)):(\d+):(\d+):\s*(error|warning|note):\s*(.+)/g;

    let match;
    while ((match = regex.exec(stderr)) !== null) {
      const line = match[1];
      const column = match[2];
      const severity = match[3];
      const message = match[4];
      if (line && column && severity && message) {
        errors.push({
          line: parseInt(line, 10),
          column: parseInt(column, 10),
          severity: severity as 'error' | 'warning' | 'note',
          message: message,
        });
      }
    }

    return errors;
  }

  override dispose(): void {
    super.dispose();
    this.clangPkg = null;
  }
}

// Singleton instance
let executorInstance: CExecutor | null = null;

/**
 * Get the singleton CExecutor instance
 * @deprecated Use ExecutorRegistry.get('c') instead
 */
export function getCExecutor(): CExecutor {
  if (!executorInstance) {
    executorInstance = new CExecutor();
  }
  return executorInstance;
}
