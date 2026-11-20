/**
 * Language Executor Interface
 *
 * Defines the contract for language-specific code execution implementations.
 * All language executors (C, Python, JavaScript, etc.) must implement this interface.
 */

import type { CodeExecutionOutcome } from '@typedcode/shared';

/**
 * Configuration for a language executor
 */
export interface ExecutorConfig {
  /** Unique identifier for the language (e.g., 'c', 'python', 'javascript') */
  id: string;
  /** Display name for the language */
  name: string;
  /** File extension including the dot (e.g., '.c', '.py', '.js') */
  fileExtension: string;
  /** Monaco editor language identifier */
  monacoLanguage: string;
  /** Icon path or CSS class for the language */
  icon?: string;
}

/**
 * Progress information during executor initialization
 */
export interface InitializationProgress {
  /** Current stage of initialization */
  stage: 'sdk' | 'compiler' | 'runtime' | 'ready';
  /** Human-readable message describing the current progress */
  message: string;
  /** Optional percentage (0-100) of completion */
  percentage?: number;
}

/**
 * 対話の実行の stdin (#707)。行の編集 (エコー・バックスペース・Enter での確定・Ctrl+D) はターミナル
 * (`CTerminal` + `terminal/stdinLineDiscipline.ts`) が受け持ち、プログラムには確定した行と EOF だけを渡す。
 * プログラムが受け取るバイト列と `terminalInput` の記録は、どちらも同じ確定した行から作る
 */
export interface InteractiveStdin {
  /** 確定した 1 行 (末尾の `"\n"` を含む) を渡す。渡した順にプログラムへ届く。`close` の後は捨てる */
  writeLine(line: string): void;
  /**
   * 入力の終わり (EOF) を送る。先に渡した行を届けてから閉じ、以後の `writeLine` は捨てる。何度呼んでもよい。
   * プログラムは止めない (止めるのは `ILanguageExecutor.abort`)
   */
  close(): void;
}

/**
 * Callbacks for handling program execution I/O
 */
export interface ExecutionCallbacks {
  /** Called when program writes to stdout */
  onStdout: (text: string) => void;
  /** Called when program writes to stderr */
  onStderr: (text: string) => void;
  /** 対話の実行で、プログラムの stdin が入力を受け取れるようになったときに 1 回呼ぶ (#707) */
  onStdinReady?: (stdin: InteractiveStdin) => void;
  /** Called to report execution progress */
  onProgress?: (message: string) => void;
  /**
   * 利用者のプログラムが動き始めたときに 1 回呼ぶ (#802)。初期化・コンパイル・パッケージの導入は
   * 済んでいる。非対話の実行は、ここから実行時間の上限を数える
   */
  onProgramStart?: () => void;
}

/**
 * 実行 1 回分の指定 (#802)。省略すると対話の実行 (ターミナルからの実行) と同じ
 */
export interface ExecutionOptions {
  /**
   * 非対話の実行の stdin。指定すると、その全体をプログラムに渡してから EOF を送り、
   * `onStdinReady` は呼ばない (ターミナルにつながない)。対応するのは C / C++ / Python
   */
  stdin?: string;
  /**
   * 最後の式の値を `=> 値` として stdout に足すか (Python だけ。既定は true = 対話の実行と同じ)。
   * 非対話の実行は false にする (期待の出力との比較に混ぜない)
   */
  showLastValue?: boolean;
}

/**
 * Result of program execution
 */
export interface ExecutionResult {
  /** Whether the program completed successfully (exit code 0) */
  success: boolean;
  /** Program exit code */
  exitCode: number;
  /** Accumulated stdout output (may be empty if streamed via callbacks) */
  stdout: string;
  /** Accumulated stderr output (may be empty if streamed via callbacks) */
  stderr: string;
  /** Error message if execution failed before program could run */
  error?: string;
  /**
   * codeExecution の result に記録する outcome (ADR-0021)。executor が決められるとき
   * (sandbox の timeout / aborted / error 等) だけ載せる。無ければ Controller が success から決める
   */
  outcome?: CodeExecutionOutcome;
  /**
   * outcome が timeout のときの、その executor の実行時間の上限 (ミリ秒)。ターミナルの
   * 「timed out after Ns」に使う。無ければ JS / TS の sandbox の上限で出す
   */
  timeoutMs?: number;
}

/**
 * Parsed compiler/runtime error with location information
 */
export interface ParsedError {
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed) */
  column: number;
  /** Error severity */
  severity: 'error' | 'warning' | 'note';
  /** Error message */
  message: string;
}

/**
 * Interface for language-specific code executors
 *
 * Implementations should:
 * 1. Initialize their runtime environment lazily (on first run or explicit init)
 * 2. Support streaming I/O for interactive programs
 * 3. Parse and report compiler/runtime errors with line numbers
 * 4. Clean up resources properly when disposed
 */
export interface ILanguageExecutor {
  /** Configuration for this executor */
  readonly config: ExecutorConfig;

  /** Whether the executor has been initialized */
  readonly isInitialized: boolean;

  /** Whether initialization is currently in progress */
  readonly isInitializing: boolean;

  /**
   * Initialize the executor's runtime environment
   * This may involve downloading WASM modules, compilers, etc.
   *
   * @param onProgress - Optional callback for progress updates
   */
  initialize(onProgress?: (progress: InitializationProgress) => void): Promise<void>;

  /**
   * Compile and run the provided code
   *
   * @param code - Source code to execute
   * @param callbacks - Callbacks for handling I/O
   * @param options - 非対話の実行の指定 (#802)。対応しない executor は無視する
   * @returns Execution result
   */
  run(code: string, callbacks: ExecutionCallbacks, options?: ExecutionOptions): Promise<ExecutionResult>;

  /**
   * Abort the currently running program
   */
  abort(): void;

  /**
   * Parse compiler/runtime error output into structured errors
   *
   * @param stderr - Error output from compilation or execution
   * @returns Array of parsed errors with location information
   */
  parseErrors(stderr: string): ParsedError[];

  /**
   * Whether the runtime has become corrupted and needs to be reset before the
   * next execution. Optional: executors extending BaseExecutor inherit this.
   */
  isRuntimeCorrupted?(): boolean;

  /**
   * Clean up resources used by the executor
   */
  dispose(): void;
}
