/**
 * Language Executor Interface
 *
 * Defines the contract for language-specific code execution implementations.
 * All language executors (C, Python, JavaScript, etc.) must implement this interface.
 */

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
  /** Default code shown when creating a new file */
  defaultCode: string;
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
 * Callbacks for handling program execution I/O
 */
export interface ExecutionCallbacks {
  /** Called when program writes to stdout */
  onStdout: (text: string) => void;
  /** Called when program writes to stderr */
  onStderr: (text: string) => void;
  /** Called when stdin stream is ready for input */
  onStdinReady?: (stdinStream: WritableStream<Uint8Array>) => void;
  /** Called to report execution progress */
  onProgress?: (message: string) => void;
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
  initialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void>;

  /**
   * Compile and run the provided code
   *
   * @param code - Source code to execute
   * @param callbacks - Callbacks for handling I/O
   * @returns Execution result
   */
  run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult>;

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
   * Clean up resources used by the executor
   */
  dispose(): void;
}
