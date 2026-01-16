/**
 * JavaScript Language Executor
 *
 * Executes JavaScript code in the browser using the built-in JS engine.
 * Captures console.log/warn/error output and routes to terminal.
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

const DEFAULT_JS_CODE = `// Welcome to JavaScript!
console.log("Hello, World!");

// Try some calculations
const sum = [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0);
console.log("Sum of 1-5:", sum);
`;

export class JavaScriptExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'javascript',
    name: 'JavaScript',
    fileExtension: '.js',
    monacoLanguage: 'javascript',
    defaultCode: DEFAULT_JS_CODE,
  };

  // For abort handling
  private abortController: AbortController | null = null;

  protected async _doInitialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void> {
    // JavaScript requires no initialization - the engine is built into the browser
    onProgress?.({
      stage: 'ready',
      message: 'JavaScript engine ready!',
      percentage: 100,
    });
  }

  async run(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    if (!this._initialized) {
      throw new Error('JavaScriptExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();
    this.abortController = new AbortController();

    let stdout = '';
    let stderr = '';

    // Create console interceptors
    const customConsole = this.createConsoleProxy(callbacks, (text) => {
      stdout += text;
    });

    try {
      callbacks.onProgress?.('Running JavaScript...');

      // Wrap code in async function to support top-level await
      const wrappedCode = this.wrapCode(code);

      // Create async function with custom scope
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const AsyncFunction = Object.getPrototypeOf(
        async function () {}
      ).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

      const fn = new AsyncFunction(
        'console',
        '__abortSignal__',
        wrappedCode
      );

      // Execute with timeout and abort support
      const result = await this.executeWithTimeout(
        fn(customConsole, this.abortController.signal),
        30000 // 30 second timeout
      );

      // If function returns a value, log it
      if (result !== undefined) {
        const resultStr = this.formatValue(result);
        callbacks.onStdout(`=> ${resultStr}\n`);
        stdout += `=> ${resultStr}\n`;
      }

      return {
        success: true,
        exitCode: 0,
        stdout,
        stderr,
      };
    } catch (error) {
      const errorInfo = this.formatError(error);
      callbacks.onStderr(errorInfo.message + '\n');
      stderr = errorInfo.message;

      return {
        success: false,
        exitCode: 1,
        stdout,
        stderr,
        error: errorInfo.message,
      };
    } finally {
      this.abortController = null;
    }
  }

  protected _onAbort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];

    // Pattern: V8/SpiderMonkey error format
    // "TypeError: Cannot read property 'x' of undefined at <anonymous>:3:5"
    const v8Regex = /at\s+(?:<anonymous>|[\w.]+):(\d+):(\d+)/g;

    let match;
    while ((match = v8Regex.exec(stderr)) !== null) {
      const [, line, column] = match;
      if (line && column) {
        // Extract error message from the beginning
        const errorMatch = stderr.match(/^(\w+Error):\s*(.+?)(?:\n|$)/);
        const message = errorMatch
          ? `${errorMatch[1]}: ${errorMatch[2]}`
          : 'JavaScript Error';

        errors.push({
          line: Math.max(1, parseInt(line, 10) - this.getWrapperLineCount()),
          column: parseInt(column, 10),
          severity: 'error',
          message,
        });
        break; // Only take the first error location
      }
    }

    return errors;
  }

  override dispose(): void {
    super.dispose();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ============ Private Helper Methods ============

  /**
   * Get the number of lines added by wrapCode
   */
  private getWrapperLineCount(): number {
    return 2; // "use strict" + blank line before user code
  }

  /**
   * Create a proxy console that intercepts all console methods
   */
  private createConsoleProxy(
    callbacks: ExecutionCallbacks,
    appendStdout: (text: string) => void
  ): Console {
    const formatArgs = (...args: unknown[]): string => {
      return args.map((arg) => this.formatValue(arg)).join(' ');
    };

    const timers = new Map<string, number>();
    const counts = new Map<string, number>();

    return {
      log: (...args: unknown[]) => {
        const text = formatArgs(...args) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      info: (...args: unknown[]) => {
        const text = '[INFO] ' + formatArgs(...args) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      warn: (...args: unknown[]) => {
        const text = '[WARN] ' + formatArgs(...args) + '\n';
        callbacks.onStderr(text);
      },
      error: (...args: unknown[]) => {
        const text = '[ERROR] ' + formatArgs(...args) + '\n';
        callbacks.onStderr(text);
      },
      debug: (...args: unknown[]) => {
        const text = '[DEBUG] ' + formatArgs(...args) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      trace: (...args: unknown[]) => {
        const text = '[TRACE] ' + formatArgs(...args) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      dir: (obj: unknown) => {
        const text = this.formatValue(obj, true) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      table: (data: unknown) => {
        const text = '[TABLE] ' + JSON.stringify(data, null, 2) + '\n';
        callbacks.onStdout(text);
        appendStdout(text);
      },
      clear: () => {
        callbacks.onStdout('\x1b[2J\x1b[H'); // ANSI clear screen
      },
      assert: (condition: boolean, ...args: unknown[]) => {
        if (!condition) {
          const text = 'Assertion failed: ' + formatArgs(...args) + '\n';
          callbacks.onStderr(text);
        }
      },
      count: (label = 'default') => {
        const count = (counts.get(label) || 0) + 1;
        counts.set(label, count);
        const text = `${label}: ${count}\n`;
        callbacks.onStdout(text);
        appendStdout(text);
      },
      countReset: (label = 'default') => {
        counts.delete(label);
      },
      group: () => {},
      groupCollapsed: () => {},
      groupEnd: () => {},
      time: (label = 'default') => {
        timers.set(label, performance.now());
      },
      timeEnd: (label = 'default') => {
        const start = timers.get(label);
        if (start !== undefined) {
          const duration = performance.now() - start;
          const text = `${label}: ${duration.toFixed(2)}ms\n`;
          callbacks.onStdout(text);
          appendStdout(text);
          timers.delete(label);
        }
      },
      timeLog: (label = 'default') => {
        const start = timers.get(label);
        if (start !== undefined) {
          const duration = performance.now() - start;
          const text = `${label}: ${duration.toFixed(2)}ms\n`;
          callbacks.onStdout(text);
          appendStdout(text);
        }
      },
    } as unknown as Console;
  }

  /**
   * Format a value for console output
   */
  private formatValue(value: unknown, expand = false): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'function') {
      return `[Function: ${value.name || 'anonymous'}]`;
    }
    if (typeof value === 'symbol') {
      return value.toString();
    }
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }
    if (Array.isArray(value)) {
      if (expand || value.length <= 10) {
        return JSON.stringify(value);
      }
      return `Array(${value.length})`;
    }
    if (typeof value === 'object') {
      try {
        const json = JSON.stringify(value, null, expand ? 2 : undefined);
        if (!expand && json.length > 100) {
          return json.slice(0, 100) + '...';
        }
        return json;
      } catch {
        return '[Object]';
      }
    }
    return String(value);
  }

  /**
   * Wrap user code to support top-level await
   */
  private wrapCode(code: string): string {
    return `
"use strict";
${code}
    `;
  }

  /**
   * Format error for display
   */
  private formatError(error: unknown): { message: string; line?: number; column?: number } {
    if (error instanceof Error) {
      const stack = error.stack || '';
      const match = stack.match(/<anonymous>:(\d+):(\d+)/);

      let message = `${error.name}: ${error.message}`;
      if (match && match[1] && match[2]) {
        const line = Math.max(1, parseInt(match[1], 10) - this.getWrapperLineCount());
        const column = parseInt(match[2], 10);
        message += ` (at line ${line}, column ${column})`;
        return { message, line, column };
      }
      return { message };
    }
    return { message: String(error) };
  }
}

// Singleton instance
let executorInstance: JavaScriptExecutor | null = null;

/**
 * Get the singleton JavaScriptExecutor instance
 */
export function getJavaScriptExecutor(): JavaScriptExecutor {
  if (!executorInstance) {
    executorInstance = new JavaScriptExecutor();
  }
  return executorInstance;
}
