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

  /** getWrapperLineCount の実測値 (初回の run で決まる) */
  private wrapperLineCount: number | null = null;

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    // JavaScript requires no initialization - the engine is built into the browser
    onProgress?.({
      stage: 'ready',
      message: 'JavaScript engine ready!',
      percentage: 100,
    });
  }

  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
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

      await this.getWrapperLineCount();

      // Wrap code in async function to support top-level await
      const fn = this.createFunction(code);

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
    return parseJavaScriptErrors(stderr);
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
   * ユーザーコードの 1 行目より前にある行数 (AsyncFunction の前置き + wrapCode の前置き)。
   *
   * AsyncFunction は本体の前に `async function anonymous(...` / `) {` の行を足し、その行数は
   * エンジンが決める。固定値で引くとずれる (#290 で 2 行ずれていたのを確認) ので、同じ形の関数で
   * 投げた例外の位置から実測する。位置が読めないときは V8 の形 (前置き 2 行 + wrapCode 2 行) とみなす。
   */
  private async getWrapperLineCount(): Promise<number> {
    if (this.wrapperLineCount !== null) return this.wrapperLineCount;
    let count = 4;
    try {
      await this.createFunction('throw new Error("calibrate")')(undefined, undefined);
    } catch (error) {
      const location = locateAnonymousFrame(error instanceof Error ? (error.stack ?? '') : '');
      if (location) count = location.line - 1;
    }
    this.wrapperLineCount = count;
    return count;
  }

  private createFunction(code: string): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    return new AsyncFunction('console', '__abortSignal__', this.wrapCode(code));
  }

  /**
   * Create a proxy console that intercepts all console methods
   */
  private createConsoleProxy(callbacks: ExecutionCallbacks, appendStdout: (text: string) => void): Console {
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
      const location = locateAnonymousFrame(error.stack || '');

      let message = `${error.name}: ${error.message}`;
      if (location) {
        const line = Math.max(1, location.line - (this.wrapperLineCount ?? 4));
        const column = location.column;
        message += ` (at line ${line}, column ${column})`;
        return { message, line, column };
      }
      return { message };
    }
    return { message: String(error) };
  }
}

/**
 * 例外のスタックから、AsyncFunction で作ったユーザーコードの位置 (前置き込みの行・列) を読む。
 * V8 は `<anonymous>:L:C`、SpiderMonkey は `> AsyncFunction:L:C` の形で出す。
 */
export function locateAnonymousFrame(stack: string): { line: number; column: number } | null {
  const match = /<anonymous>:(\d+):(\d+)/.exec(stack) ?? /> (?:Async)?Function:(\d+):(\d+)/.exec(stack);
  if (!match?.[1] || !match[2]) return null;
  return { line: parseInt(match[1], 10), column: parseInt(match[2], 10) };
}

/**
 * 実行時エラーの出力 (`TypeError: ... (at line N, column M)`) からエディタのマーカーを作る。
 * 行・列は出力の時点でユーザーコードの位置に直してあるので、ここでは引き算しない。
 * 読むのは executor 自身が出す `(at line N, column M)` の形だけ (ユーザーが console に出した
 * スタックの文字列からはマーカーを作らない)。最初の 1 件だけを返す。
 */
export function parseJavaScriptErrors(stderr: string): ParsedError[] {
  const match = /^(.*?)\s*\(at line (\d+), column (\d+)\)\s*$/m.exec(stderr);
  if (!match?.[2] || !match[3]) return [];
  const message = (match[1] ?? '').trim() || 'JavaScript Error';
  return [
    {
      line: Math.max(1, parseInt(match[2], 10)),
      column: Math.max(1, parseInt(match[3], 10)),
      severity: 'error',
      message,
    },
  ];
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
