/**
 * C Language Executor using Wasmer SDK
 * Compiles and executes C code in the browser using WebAssembly
 */

import { init, Wasmer, Directory, type SpawnOptions } from '@wasmer/sdk';
import wasmUrl from '@wasmer/sdk/wasm?url';

export interface CompileResult {
  success: boolean;
  binary?: Uint8Array;
  errors?: string[];
  warnings?: string[];
}

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ParsedError {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface ExecutionCallbacks {
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
  onStdinReady?: (stdinStream: WritableStream<Uint8Array>) => void;
  onProgress?: (message: string) => void;
}

export class CExecutor {
  private initialized: boolean = false;
  private initializing: boolean = false;
  private clangPkg: Wasmer | null = null;

  /**
   * Check if the executor is initialized
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize Wasmer SDK and download Clang
   */
  async initialize(onProgress?: (message: string) => void): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      // Wait for ongoing initialization
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.initializing = true;

    try {
      onProgress?.('Initializing Wasmer SDK...');
      await init({ module: wasmUrl });

      onProgress?.('Downloading C compiler (this may take a while)...');
      // Use clang package from Wasmer registry
      // See: https://wasmer.io/syrusakbary/clang
      this.clangPkg = await Wasmer.fromRegistry('syrusakbary/clang');

      this.initialized = true;
      onProgress?.('C compiler ready!');
    } catch (error) {
      console.error('[CExecutor] Initialization failed:', error);
      throw new Error(`Failed to initialize C compiler: ${error}`);
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Compile and run C code
   */
  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    if (!this.initialized || !this.clangPkg) {
      throw new Error('CExecutor not initialized. Call initialize() first.');
    }

    try {
      callbacks.onProgress?.('Compiling...');

      // Create virtual filesystem with source file
      const project = new Directory();
      await project.writeFile('main.c', code);

      const entrypoint = this.clangPkg.entrypoint;
      if (!entrypoint) {
        throw new Error('Clang package has no entrypoint');
      }

      // Compile the C code
      const compileOptions: SpawnOptions = {
        args: [
          '/project/main.c',
          '-o', '/project/main.wasm',
          '-target', 'wasm32-wasi',
          '-O2',
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
      // Note: pipeTo() runs in background - we don't wait for it
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
      callbacks.onStderr(`Error: ${errorMsg}\n`);
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: errorMsg,
        error: errorMsg,
      };
    }
  }

  /**
   * Abort current execution (placeholder for future implementation)
   */
  abort(): void {
    console.log('[CExecutor] Abort requested');
    // TODO: Implement proper abort mechanism for WASI programs
  }

  /**
   * Parse compiler error output
   */
  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // clang error format: "filename:line:column: severity: message"
    const regex = /(?:<stdin>|main\.c|[\w.]+\.c):(\d+):(\d+):\s*(error|warning|note):\s*(.+)/g;

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
}

// Singleton instance
let executorInstance: CExecutor | null = null;

export function getCExecutor(): CExecutor {
  if (!executorInstance) {
    executorInstance = new CExecutor();
  }
  return executorInstance;
}
