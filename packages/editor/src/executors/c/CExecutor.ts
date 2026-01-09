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
        message: 'Downloading C compiler (this may take a while)...',
        percentage: 30,
      });

      // Use clang package from Wasmer registry
      // See: https://wasmer.io/syrusakbary/clang
      this.clangPkg = await Wasmer.fromRegistry('syrusakbary/clang');

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

      // Create virtual filesystem with source file
      const project = new Directory();
      await project.writeFile(sourceFile, code);

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

      const decoder = new TextDecoder();

      // Connect stdout using pipeTo() for direct streaming
      runInstance.stdout.pipeTo(
        new WritableStream({
          write: (chunk) => {
            callbacks.onStdout(decoder.decode(chunk));
          },
        })
      ).catch(() => {
        // Ignore pipe errors (e.g., when program ends)
      });

      // Connect stderr using pipeTo() for direct streaming
      runInstance.stderr.pipeTo(
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
        callbacks.onStdinReady?.(stdinStream);
      }

      // Wait for the program to finish
      const runResult = await runInstance.wait();

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
        callbacks.onStderr(`Error: ${errorMsg}\n`);
        callbacks.onStderr('Runtime error detected. Will auto-reset on next execution.\n');
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
    // TODO: Implement proper abort mechanism for WASI programs
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
