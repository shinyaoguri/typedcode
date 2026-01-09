/**
 * Base Executor
 *
 * Abstract base class providing common functionality for language executors.
 * Subclasses should implement the abstract methods for language-specific behavior.
 */

import type {
  ILanguageExecutor,
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

export abstract class BaseExecutor implements ILanguageExecutor {
  abstract readonly config: ExecutorConfig;

  protected _initialized: boolean = false;
  protected _initializing: boolean = false;
  protected _abortRequested: boolean = false;
  protected _runtimeCorrupted: boolean = false;

  get isInitialized(): boolean {
    return this._initialized;
  }

  get isInitializing(): boolean {
    return this._initializing;
  }

  /**
   * Check if runtime is corrupted and needs reset
   */
  isRuntimeCorrupted(): boolean {
    return this._runtimeCorrupted;
  }

  /**
   * Mark runtime as corrupted (to be reset on next execution)
   */
  protected markRuntimeCorrupted(): void {
    this._runtimeCorrupted = true;
  }

  /**
   * Reset the runtime to initial state
   * Subclasses should override this for language-specific reset
   */
  async resetRuntime(): Promise<void> {
    this._initialized = false;
    this._runtimeCorrupted = false;
  }

  /**
   * Initialize the executor
   * Subclasses should override _doInitialize() for language-specific initialization
   */
  async initialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void> {
    if (this._initialized) return;

    if (this._initializing) {
      // Wait for ongoing initialization
      while (this._initializing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this._initializing = true;

    try {
      await this._doInitialize(onProgress);
      this._initialized = true;
    } finally {
      this._initializing = false;
    }
  }

  /**
   * Language-specific initialization logic
   * Subclasses must implement this method
   */
  protected abstract _doInitialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void>;

  /**
   * Run the provided code
   * Subclasses must implement this method
   */
  abstract run(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult>;

  /**
   * Request abort of current execution
   */
  abort(): void {
    this._abortRequested = true;
    this._onAbort();
  }

  /**
   * Language-specific abort handling
   * Subclasses can override this for custom abort logic
   */
  protected _onAbort(): void {
    // Default implementation does nothing
    // Subclasses can override for custom abort handling
  }

  /**
   * Parse error output
   * Subclasses must implement this method
   */
  abstract parseErrors(stderr: string): ParsedError[];

  /**
   * Clean up resources
   * Subclasses can override for custom cleanup logic
   */
  dispose(): void {
    this._initialized = false;
    this._initializing = false;
    this._abortRequested = false;
    this._runtimeCorrupted = false;
  }

  /**
   * Helper method to check if execution should be aborted
   */
  protected shouldAbort(): boolean {
    return this._abortRequested;
  }

  /**
   * Helper method to reset abort state before new execution
   */
  protected resetAbort(): void {
    this._abortRequested = false;
  }

  /**
   * Execute a promise with timeout support
   *
   * @param promise The promise to execute
   * @param timeoutMs Timeout in milliseconds
   * @param timeoutMessage Optional custom timeout message
   * @returns The resolved value of the promise
   * @throws Error if the promise times out
   */
  protected executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage?: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage ?? `Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
