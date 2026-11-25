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
import { WasmerSdkCorruptedError } from './errors.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
  InitializationProgress,
  InteractiveStdin,
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
export const WORKSPACE_DIR = '/workspace';

/**
 * 利用者のコードの後ろに付けるリンクの引数 (C / C++ 共通)。
 *
 * webc のドライバは `-D_WASI_EMULATED_PROCESS_CLOCKS` を自分で足して `<time.h>` に `clock()` を宣言させるが、
 * リンクには `-lc` しか渡さず、実体のある `libwasi-emulated-process-clocks.a` (sysroot にある) を足さない。
 * そのままでは `clock()` が `undefined symbol: clock` でリンクに落ちる (#714)。
 * このライブラリの `clock()` はプログラムの開始からの CLOCK_MONOTONIC の経過 (= 実時間) を返し、CPU 時間ではない
 */
const LINK_ARGS = ['-lwasi-emulated-process-clocks'];

/** 出力の target (C / C++ 共通)。WASI の wasm を作り、Wasmer の sandbox で動かす */
const TARGET_ARGS = ['-target', 'wasm32-wasi'];

/**
 * C のコンパイルフラグ (#710)。授業に合わせて固定した値の正本で、学生は変えられない (設定の UI も配布物の欄も持たない)。
 *
 * - `-std=c17`: 規格を C17 に固定する (GNU 拡張のモードではない。`__STRICT_ANSI__` が立つので、wasi-libc (musl) は
 *   POSIX / BSD の拡張 (`<math.h>` の `M_PI`・`<time.h>` の `nanosleep` など) を、`_POSIX_C_SOURCE` などの機能マクロを書かないかぎり宣言しない)
 * - `-Wall -Wextra -Wpedantic`: 主な警告を出す (未使用の変数・printf の書式の不一致など)。警告はエラーにしない
 * - `-Werror=implicit-function-declaration`: 宣言の無い関数の呼び出し (ヘッダの書き忘れなど) だけはエラーにする
 * - `-O0`: 最適化しない (未定義動作を定義するものではない)
 *
 * C だけに付ける: `CppExecutor` は自分の `compileArgs` を渡し、これを使わない (C++ の設定は #710 の範囲外)。
 * 値を変えたら `packages/editor/README.md` の「ブラウザ内コード実行」の記述も直す
 */
export const C_COMPILE_FLAGS: readonly string[] = [
  '-std=c17',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Werror=implicit-function-declaration',
  '-O0',
];

/**
 * clang に渡す引数の全体 (#710)。入力 (利用者のソースと stdout の支援コード) → 出力 → target → 言語ごとの
 * フラグ (`compileArgs`) → リンクの引数、の順に並べる
 */
export function buildClangArgs(sourceFile: string, compileArgs: readonly string[]): string[] {
  return [
    `${WORKSPACE_DIR}/${sourceFile}`,
    `${WORKSPACE_DIR}/${stdoutSupportFileName(sourceFile)}`,
    '-o',
    `${WORKSPACE_DIR}/main.wasm`,
    ...TARGET_ARGS,
    ...compileArgs,
    ...LINK_ARGS,
  ];
}

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

// 判定する側が Wasmer を読まずに済むよう、型は errors.ts に置く (#617)
export { WasmerSdkCorruptedError };

/** stdout を非バッファにする支援コードのファイル名 (拡張子を除く)。利用者のソースの隣に置く */
const STDOUT_SUPPORT_BASENAME = '__typedcode_stdout';

/**
 * stdout を非バッファにする支援コード (#709)。利用者のソースとは**別の翻訳単位**としてコンパイル・リンクする。
 *
 * 利用者のプログラムの stdin / stdout は pipe で (#707。tty にしない)、そのままでは stdout がフルバッファになり、
 * 改行の無いプロンプト (`printf("name? ")`) が入力を待つ間に出ない。constructor で main より前に
 * `setvbuf(stdout, NULL, _IONBF, 0)` を呼び、書いた分がすぐターミナルに出るようにする。
 * 利用者が main の中で自分でバッファを渡して `setvbuf(stdout, buf, _IOFBF, sizeof buf)` を呼べば、その設定が後から
 * 上書きする (`fflush` もそのまま効く)。ただし wasi-libc (musl) の `setvbuf` はバッファを渡されたときだけ大きさを
 * 変えるので、`setvbuf(stdout, NULL, _IOFBF, n)` では非バッファのまま (ネイティブの pipe の既定のフルバッファとは違う。
 * 回帰は `packages/e2e/tests/code-execution-c-stdout.spec.ts`)。
 *
 * 利用者のソースには何も前置しない: 前置すると `stdio.h` を書き忘れたコードが通り、利用者の翻訳単位に
 * `FILE` や `EOF` などの宣言が入る (#709)。行番号・`__LINE__`・`__FILE__` も利用者のソースのまま (#489)。
 * C++ では同じ内容を `.cpp` としてコンパイルする (C++ の実行の `-std=c++17` は C の入力に付けられない)。
 * C++ のとき libc++ の `<stdio.h>` が出す「Clang 17 以降」の警告は、CppExecutor が `-include` する guard
 * (`LIBCXX_VERSION_WARNING_GUARD`。#871) が、利用者のソースとこの翻訳単位の両方で黙らせる。ここに `#pragma` を
 * 重ねない (同じ原因 (#573) の手当てを 1 か所にまとめ、版の揃った webc に替えたときに一緒に外せるようにする)
 */
export const STDOUT_SUPPORT_SOURCE = `/* TypedCode: unbuffered stdout for immediate output (#709) */
#include <stdio.h>
__attribute__((constructor))
static void __typedcode_init_stdout(void) {
    setvbuf(stdout, (char *)0, _IONBF, 0);
}
`;

/** 支援コードのファイル名。利用者のソースと同じ拡張子にして、clang に同じ言語として扱わせる */
export function stdoutSupportFileName(sourceFile: string): string {
  const dot = sourceFile.lastIndexOf('.');
  return `${STDOUT_SUPPORT_BASENAME}${dot >= 0 ? sourceFile.slice(dot) : '.c'}`;
}

/** Options for compiling with different settings */
export interface CompileOptions {
  sourceFile?: string;
  /** target の後ろに付ける言語ごとのフラグ (規格・警告・最適化)。C は `C_COMPILE_FLAGS` */
  compileArgs?: readonly string[];
  /** 利用者のソースと一緒に sandbox に置くファイル (ゲストの絶対パス → 内容)。`-include` で読ませるヘッダなど (#871) */
  extraFiles?: Readonly<Record<string, string>>;
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
      // 失敗した回の client (worker pool) を手放す。次の initialize が作り直す (#617。再試行で client を溜めない)
      this.closeWasmer();
      this.clangPkg = null;

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
    return this.runWithOptions(code, callbacks, { compileArgs: C_COMPILE_FLAGS }, execution);
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

      // 利用者のソースはそのまま置き、stdout の支援コードは別の翻訳単位として隣に置く (#709)
      const supportFile = stdoutSupportFileName(sourceFile);

      // Each run gets a fresh sandbox holding clang and the source files
      sandbox = await wasmer.sandboxes.create({
        packages: [clangPkg],
        files: {
          ...options.extraFiles,
          [`${WORKSPACE_DIR}/${sourceFile}`]: code,
          [`${WORKSPACE_DIR}/${supportFile}`]: STDOUT_SUPPORT_SOURCE,
        },
      });
      if (run.aborted) return abortedResult();

      // Compile the code (clang package used as selector = its entrypoint).
      // run() ではなく spawn() で起こし、abort() がコンパイラを止められるよう Process を持つ (#711)
      const compiler = await sandbox
        .command(clangPkg, buildClangArgs(sourceFile, extraArgs))
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
          // 対話の実行 (#707): ターミナルが確定した行と EOF を pipe に渡す。tty (`terminal: true`) は使わない
          // (行の編集は Python と同じ line discipline が受け持ち、記録と受け取る行を同じ文字列にする)
          callbacks.onStdinReady?.(pipeInteractiveStdin(runInstance.stdin));
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
      /(<stdin>|main\.c(?:pp)?|[\w.]+\.(?:c|cpp|cc|cxx)):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)/g;

    for (const match of stderr.matchAll(regex)) {
      // 支援コード (別の翻訳単位。#709) の診断は利用者のソースの行ではないので、マーカーにしない
      if (match[1]?.startsWith(`${STDOUT_SUPPORT_BASENAME}.`)) continue;
      const line = match[2];
      const column = match[3];
      const severity = match[4];
      const message = match[5];
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
 * 対話の実行の stdin (#707) を Wasmer の pipe に写す。書き込みと close を 1 本の列に並べ、渡した行を
 * 順に届けてから閉じる (close で EOF。プログラムは止めない)。close の後の行は捨てる。
 * プログラムが先に終わって書けなかったときの失敗は捨てる
 */
export function pipeInteractiveStdin(stdin: WritableBytes): InteractiveStdin {
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): void => {
    queue = queue.then(op).catch(() => {
      // 読まずに終わった・既に閉じている
    });
  };
  return {
    writeLine(line) {
      if (closed) return;
      enqueue(() => stdin.write(line));
    },
    close() {
      if (closed) return;
      closed = true;
      enqueue(() => stdin.close());
    },
  };
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
