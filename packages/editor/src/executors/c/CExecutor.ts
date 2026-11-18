/**
 * C Language Executor
 *
 * Compiles and executes C code in the browser using Wasmer SDK and Clang.
 */

// 0.19 以降の SDK は wasm 本体と worker を自分で `new URL(..., import.meta.url)` で解決する
// (旧 `init({ module })` と `@wasmer/sdk/wasm?url` は廃止。#364)
import {
  Wasmer,
  type Output,
  type Package,
  type Process,
  type ReadableBytes,
  type Sandbox,
  type WritableBytes,
} from '@wasmer/sdk';

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

// Re-export ParsedError for backward compatibility
export type { ParsedError } from '../interfaces/ILanguageExecutor.js';

/**
 * Error patterns that indicate runtime corruption requiring reset
 */
/**
 * Clang compiler version hosted on Cloudflare R2
 * Update this when uploading a new version via scripts/update-clang.sh
 */
const CLANG_VERSION = '0.1.1';

/** Guest directory where the source and compiled binary are placed */
const WORKSPACE_DIR = '/workspace';

const RUNTIME_ERROR_PATTERNS = [
  'runtimeerror',
  'memory access out of bounds',
  'unreachable executed',
  'unreachable',
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
  'atomics.wait',
];

/**
 * Error class for unrecoverable Wasmer SDK corruption
 * When this error is thrown, user must reload the page
 */
export class WasmerSdkCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmerSdkCorruptedError';
  }
}

/**
 * clang に渡すソースを組み立てる: stdout を非バッファ化する preamble + ユーザーのコード。
 * stdout は行バッファから非バッファに切り替わり、ローカル端末と同じ見え方になる。
 *
 * preamble の最後の `#line 1` で、直後のユーザーのコードの 1 行目を 1 行目として数え直させる。
 * これが無いと clang のエラー行が preamble の行数分ずれ、エディタのマーカーが範囲外になる (#489)。
 * ファイル名は指定しない (`main.c` / `main.cpp` のまま。`parseErrors` が読む形を変えない)。
 * 行数を変える編集をするときは `#line 1` を必ずユーザーのコードの直前に置くこと。
 */
export function buildSourceWithPreamble(code: string): string {
  const preamble = `#include <stdio.h>
/* TypedCode: Force unbuffered stdout for immediate output */
__attribute__((constructor))
static void __typedcode_init_stdout(void) {
    setvbuf(stdout, (char *)0, _IONBF, 0);
}
#line 1
`;
  return preamble + code;
}

/** Options for compiling with different settings */
export interface CompileOptions {
  sourceFile?: string;
  compileArgs?: string[];
}

/**
 * 実行 1 回分の所有権 (#711)。`abort()` はその時点の run にだけ `aborted` を立て、
 * 保持している Process (コンパイラか利用者プログラム) を止める。run は段階の境目ごとに
 * 自分の `aborted` を見て、立っていれば後続の段階 (特に利用者プログラムの起動) へ進まない。
 * 基底の `_abortRequested` は次の run の `resetAbort()` で消えるので、run の判定には使わない
 */
interface ActiveRun {
  aborted: boolean;
  /** 今の段階で止める対象 (コンパイル中はコンパイラ、実行中は利用者プログラム) */
  process: Process | null;
  /** process が利用者プログラムか (停止の通知と既存の 137 の流儀を分ける) */
  isProgram: boolean;
  callbacks: ExecutionCallbacks;
}

/** 停止した run の結果。controller は aborted を自分で記録するので、ここは executor 単体の契約 */
function abortedResult(exitCode = 1): ExecutionResult {
  return { success: false, exitCode, stdout: '', stderr: '', outcome: 'aborted' };
}

export class CExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'c',
    name: 'C',
    fileExtension: '.c',
    monacoLanguage: 'c',
    icon: 'c-icon',
  };

  /** Wasmer client (owns the worker pool and runtime) */
  protected wasmer: Wasmer | null = null;

  protected clangPkg: Package | null = null;

  /** Cached Clang binary to avoid re-downloading on reset */
  private clangBinary: Uint8Array | null = null;

  /** The run that `abort()` stops (null when nothing is running). See ActiveRun */
  private activeRun: ActiveRun | null = null;

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    try {
      onProgress?.({
        stage: 'sdk',
        message: 'Initializing Wasmer SDK...',
        percentage: 10,
      });

      this.wasmer = new Wasmer();
      await this.wasmer.ready();

      // Cache Clang binary to avoid re-downloading on reset
      if (!this.clangBinary) {
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
        this.clangBinary = new Uint8Array(await response.arrayBuffer());
      } else {
        onProgress?.({
          stage: 'compiler',
          message: 'Loading C compiler from cache...',
          percentage: 30,
        });
      }

      this.clangPkg = await this.wasmer.packages.load(this.clangBinary);

      onProgress?.({
        stage: 'ready',
        message: 'C compiler ready!',
        percentage: 100,
      });
    } catch (error) {
      console.error('[CExecutor] Initialization failed:', error);

      // Check if this is an unrecoverable Wasmer SDK corruption
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.isRuntimeCorruptionError(error)) {
        // Mark as corrupted so we don't keep trying
        this.markRuntimeCorrupted();
        throw new WasmerSdkCorruptedError(
          'The WebAssembly runtime is corrupted. Please reload the page to continue using the C/C++ compiler.'
        );
      }

      throw new Error(`Failed to initialize C compiler: ${errorMsg}`);
    }
  }

  async run(code: string, callbacks: ExecutionCallbacks, execution: ExecutionOptions = {}): Promise<ExecutionResult> {
    return this.runWithOptions(code, callbacks, {}, execution);
  }

  /**
   * Run code with custom compile options (for subclasses like CppExecutor)
   */
  protected async runWithOptions(
    code: string,
    callbacks: ExecutionCallbacks,
    options: CompileOptions,
    execution: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    // 復旧の初期化より前に run を登録し、その待ちの間の abort もこの run に効かせる (#711)
    const run: ActiveRun = { aborted: false, process: null, isProgram: false, callbacks };
    this.activeRun = run;
    this.resetAbort();
    try {
      return await this.runOwned(run, code, callbacks, options, execution);
    } finally {
      // 停止後に始まった新しい run の所有を、古い run の後始末が外さない
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  /** runWithOptions の本体。段階の境目ごとに `run.aborted` を見て、立っていれば先へ進まない */
  private async runOwned(
    run: ActiveRun,
    code: string,
    callbacks: ExecutionCallbacks,
    options: CompileOptions,
    execution: ExecutionOptions
  ): Promise<ExecutionResult> {
    // Auto-reset and reinitialize if runtime was corrupted
    if (this._runtimeCorrupted) {
      console.log('[CExecutor] Runtime was corrupted, attempting recovery...');
      callbacks.onProgress?.('Resetting runtime due to previous error...');
      await this.resetRuntime();

      try {
        // Reinitialize after reset (uses cached binary, so no re-download needed)
        await this.initialize((progress) => {
          callbacks.onProgress?.(progress.message);
        });
      } catch (error) {
        if (run.aborted) return abortedResult();
        // If reinitialization fails with SDK corruption, inform user to reload
        if (error instanceof WasmerSdkCorruptedError) {
          callbacks.onStderr(
            '\n[System] The WebAssembly runtime is corrupted and cannot be recovered.\n' +
              '[System] Please reload the page to continue using the C/C++ compiler.\n'
          );
          return {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: error.message,
            error: error.message,
          };
        }
        throw error;
      }
      // 初期化を待つ間に停止された
      if (run.aborted) return abortedResult();
    }

    if (!this._initialized || !this.wasmer || !this.clangPkg) {
      throw new Error('Executor not initialized. Call initialize() first.');
    }

    const sourceFile = options.sourceFile ?? 'main.c';
    const extraArgs = options.compileArgs ?? [];

    const wasmer = this.wasmer;
    const clangPkg = this.clangPkg;
    let sandbox: Sandbox | null = null;

    try {
      callbacks.onProgress?.('Compiling...');

      const modifiedCode = buildSourceWithPreamble(code);

      // Each run gets a fresh sandbox holding clang and the source file
      sandbox = await wasmer.sandboxes.create({
        packages: [clangPkg],
        files: { [`${WORKSPACE_DIR}/${sourceFile}`]: modifiedCode },
      });
      if (run.aborted) return abortedResult();

      // Compile the code (clang package used as selector = its entrypoint).
      // run() ではなく spawn() で起こし、abort() がコンパイラを止められるよう Process を持つ (#711)
      const compiler = await sandbox
        .command(clangPkg, [
          `${WORKSPACE_DIR}/${sourceFile}`,
          '-o',
          `${WORKSPACE_DIR}/main.wasm`,
          '-target',
          'wasm32-wasi',
          '-O2',
          ...extraArgs,
        ])
        .spawn({ stdin: 'closed', stdout: 'capture', stderr: 'capture' });
      if (!this.holdProcess(run, compiler, false)) return abortedResult();
      const compileResult = await compiler.wait({ check: false });
      run.process = null;
      // コンパイル中に停止された (SDK がコンパイラを殺せずに完了まで走った場合も含む)
      if (run.aborted) return abortedResult();

      // コンパイラの診断は成否を問わずここで 1 回だけ転送する (#708)。成功時の警告もターミナルと
      // マーカーに出し、実行結果 (success / exitCode) はプログラムの終わり方だけで決める
      const stderr = compileResult.stderr.text();
      if (stderr) callbacks.onStderr(stderr);

      if (compileResult.exitCode !== 0) {
        // Compilation failed (診断は上で転送済み)
        return {
          success: false,
          exitCode: compileResult.exitCode,
          stdout: compileResult.stdout.text(),
          stderr: stderr,
          error: 'Compilation failed',
        };
      }

      callbacks.onProgress?.('Running...');

      // Read the compiled WASM binary and install it as a package (raw wasm → command `main`)
      const wasmBinary = await sandbox.fs.readFile(`${WORKSPACE_DIR}/main.wasm`);
      if (run.aborted) return abortedResult();
      const program = await sandbox.installPackage(wasmBinary);
      if (run.aborted) return abortedResult();

      // Start the program
      const runInstance = await sandbox.command(program).spawn({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      if (!this.holdProcess(run, runInstance, true)) return abortedResult();

      // Stream stdout/stderr to callbacks. Keep the promises to ensure all output
      // is flushed before returning
      const stdoutPromise = pumpOutput(runInstance.stdout, callbacks.onStdout);
      const stderrPromise = pumpOutput(runInstance.stderr, callbacks.onStderr);

      if (runInstance.stdin) {
        if (execution.stdin !== undefined) {
          // 非対話の実行 (#802): 全体を書いてから閉じる (EOF)。ターミナルにはつながない
          feedAndClose(runInstance.stdin, execution.stdin);
        } else {
          // Notify caller that stdin is ready for connection
          callbacks.onStdinReady?.(runInstance.stdin.toWritableStream());
        }
      }
      callbacks.onProgramStart?.();

      // Wait for the program to finish
      let runResult: Output;
      try {
        runResult = await runInstance.wait();
      } finally {
        run.process = null;
      }
      // 停止された run は、kill が間に合わずに exit 0 で終わっても success にしない
      if (run.aborted) return abortedResult(runResult.exitCode);

      // Wait for output streams to flush with a timeout
      // (safety valve in case a stream doesn't close properly)
      const flushTimeout = new Promise<void>((resolve) => setTimeout(resolve, 100));
      await Promise.race([Promise.all([stdoutPromise, stderrPromise]), flushTimeout]);

      return {
        success: runResult.exitCode === 0,
        exitCode: runResult.exitCode,
        stdout: '', // Already streamed via callbacks
        stderr: '', // Already streamed via callbacks
      };
    } catch (error) {
      // 停止済みの run の遅れた失敗は、新しい run の runtime 状態 (破損の印) にも出力にも触れない
      if (run.aborted) return abortedResult();
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
    } finally {
      // Release the per-run sandbox (errors on close are not actionable)
      if (sandbox) {
        sandbox.close().catch(() => {});
      }
    }
  }

  protected _onAbort(): void {
    console.log('[CExecutor] Abort requested');
    const run = this.activeRun;
    if (!run) return;
    // この run を手放す: 以後の段階の境目でこの run は先へ進まない (#711)
    run.aborted = true;
    this.activeRun = null;
    if (run.process) {
      this.killProcess(run, run.process, run.isProgram);
    }
  }

  /**
   * spawn した Process を run に持たせる。spawn を待つ間に停止されていたら、
   * 起動したばかりの Process をその場で止めて false を返す (呼び出し側は先へ進まない)
   */
  private holdProcess(run: ActiveRun, process: Process, isProgram: boolean): boolean {
    if (run.aborted) {
      this.killProcess(run, process, isProgram);
      return false;
    }
    run.process = process;
    run.isProgram = isProgram;
    return true;
  }

  /** 停止した run の Process (コンパイラか利用者プログラム) を止める */
  private killProcess(run: ActiveRun, process: Process, isProgram: boolean): void {
    // Force-terminate the process
    process.kill().catch(() => {
      // Ignore errors - process may already have exited
    });

    if (isProgram) {
      // Notify user
      run.callbacks.onStderr(
        '\n[System] Program stopped.\n' + '[System] Runtime will be automatically reset on next execution.\n'
      );
    }

    // Mark runtime for reset as a conservative fallback
    // (in case the kill leaves the worker pool in a bad state; the same holds for the compiler)
    this.markRuntimeCorrupted();
    run.process = null;
    console.log('[CExecutor] Runtime marked for reset');
  }

  /**
   * Check if an error indicates runtime corruption
   */
  private isRuntimeCorruptionError(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const lowerMsg = errorMsg.toLowerCase();
    return RUNTIME_ERROR_PATTERNS.some((pattern) => lowerMsg.includes(pattern));
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
   * Clears all instance references but keeps cached binary for fast reinitialization
   */
  override async resetRuntime(): Promise<void> {
    console.log('[CExecutor] Performing full runtime reset...');

    // 実行中の run の所有 (activeRun) はここで外さない: 復旧のための reset は run の中から呼ばれ、
    // その間の abort もその run に効かせる (#711)

    // Close the Wasmer client and clear Clang package (but keep binary cached for fast reload)
    this.closeWasmer();
    this.clangPkg = null;

    // Reset base class state
    await super.resetRuntime();

    console.log('[CExecutor] Runtime reset complete, will reinitialize on next run');
  }

  /**
   * Close the Wasmer client (releases workers) and drop the reference
   */
  private closeWasmer(): void {
    const wasmer = this.wasmer;
    this.wasmer = null;
    wasmer?.close().catch((error: unknown) => {
      console.warn('[CExecutor] Failed to close Wasmer client:', error);
    });
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // clang error format: "filename:line:column: severity: message"
    // Matches .c, .cpp, .cc, .cxx files
    // `fatal error` (例: 見つからない #include) は error のマーカーにする (#708)
    const regex =
      /(?:<stdin>|main\.c(?:pp)?|[\w.]+\.(?:c|cpp|cc|cxx)):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)/g;

    for (const match of stderr.matchAll(regex)) {
      const line = match[1];
      const column = match[2];
      const severity = match[3];
      const message = match[4];
      if (line && column && severity && message) {
        errors.push({
          line: parseInt(line, 10),
          column: parseInt(column, 10),
          severity: severity === 'fatal error' ? 'error' : (severity as 'error' | 'warning' | 'note'),
          message: message,
        });
      }
    }

    return errors;
  }

  override dispose(): void {
    // 実行中の run を止めてから手放す (止めずに参照だけ外すと、その run が後続の段階へ進む)
    this._onAbort();
    super.dispose();
    this.closeWasmer();
    this.clangPkg = null;
    this.clangBinary = null; // Release cached binary on dispose
  }
}

/**
 * 非対話の実行の stdin を書いて閉じる (#802)。待たない: 読まずに終わるプログラムでも run を止めない。
 * 書けなかった (プログラムが先に終わった) ときの失敗は捨てる
 */
function feedAndClose(stdin: WritableBytes, text: string): void {
  void (async () => {
    try {
      if (text) await stdin.write(text);
    } catch {
      // 読まずに終わったプログラム
    }
    try {
      await stdin.close();
    } catch {
      // 既に閉じている
    }
  })();
}

/**
 * Decode a process output stream and forward it to a callback.
 * Stream errors (e.g., when the program ends abruptly) are ignored.
 */
async function pumpOutput(stream: ReadableBytes | null, onText: (text: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) onText(text);
    }
    const rest = decoder.decode();
    if (rest) onText(rest);
  } catch {
    // Ignore stream errors
  }
}

// Singleton instance
let executorInstance: CExecutor | null = null;

/**
 * Get the singleton CExecutor instance
 */
export function getCExecutor(): CExecutor {
  if (!executorInstance) {
    executorInstance = new CExecutor();
  }
  return executorInstance;
}
