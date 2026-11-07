/**
 * TypeScript Language Executor
 *
 * Transpiles TypeScript code to JavaScript and executes it using JavaScriptExecutor
 * (the sandboxed iframe + Worker of #290).
 * Transpilation runs in Monaco's bundled TypeScript worker (`getEmitOutput`, no type checking. #605),
 * so the editor bundle does not carry its own copy of the TypeScript compiler.
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import { getJavaScriptExecutor } from '../javascript/JavaScriptExecutor.js';
import { transpileWithMonaco } from './monacoTranspile.js';
import { formatTranspileDiagnostics } from './transpileDiagnostics.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

export class TypeScriptExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'typescript',
    name: 'TypeScript',
    fileExtension: '.ts',
    monacoLanguage: 'typescript',
  };

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    // Monaco's TypeScript worker is started lazily on the first transpile
    onProgress?.({
      stage: 'ready',
      message: 'TypeScript (Monaco worker) ready!',
      percentage: 100,
    });
  }

  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    if (!this._initialized) {
      throw new Error('TypeScriptExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();

    try {
      callbacks.onProgress?.('Transpiling TypeScript...');

      // Transpile TypeScript to JavaScript in Monaco's TypeScript worker (syntax only, no type checking)
      const result = await transpileWithMonaco(code);
      // worker の初回ロードは数秒かかるので、その間に停止されたら実行せずに中止で返す
      if (this.shouldAbort()) {
        return { success: false, exitCode: 1, stdout: '', stderr: '', outcome: 'aborted' };
      }

      // Report compilation errors if any
      const errors = formatTranspileDiagnostics(code, result.diagnostics);
      if (errors.length > 0) {
        callbacks.onStderr(errors + '\n');
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: errors,
          error: 'TypeScript compilation failed',
        };
      }

      callbacks.onProgress?.('Running JavaScript...');

      // Execute using JavaScriptExecutor
      const jsExecutor = getJavaScriptExecutor();
      if (!jsExecutor.isInitialized) {
        await jsExecutor.initialize();
      }
      // 初期化を待つ間に停止されたら、sandbox を作らずに中止で返す (#290)
      if (this.shouldAbort()) {
        return { success: false, exitCode: 1, stdout: '', stderr: '', outcome: 'aborted' };
      }

      // 実行は JavaScriptExecutor の sandbox (opaque origin の iframe 内の Worker) に任せる
      return await jsExecutor.run(result.outputText, callbacks);
    } catch (error) {
      // 変換 (Monaco の TS worker) や実行環境の準備の失敗は、ユーザーのコードの失敗ではなく実行基盤の例外 (ADR-0021 の error)
      const errorMsg = error instanceof Error ? error.message : String(error);
      callbacks.onStderr(`TypeScript Error: ${errorMsg}\n`);
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: errorMsg,
        error: errorMsg,
        outcome: 'error',
      };
    }
  }

  protected _onAbort(): void {
    // Delegate to JavaScriptExecutor's abort
    getJavaScriptExecutor().abort();
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // TypeScript error format: "(line,column): error TS1234: message"
    const regex = /\((\d+),(\d+)\):\s*(error|warning)\s*TS\d+:\s*(.+)/g;

    for (const match of stderr.matchAll(regex)) {
      const [, line, column, severity, message] = match;
      if (line && column && severity && message) {
        errors.push({
          line: parseInt(line, 10),
          column: parseInt(column, 10),
          severity: severity as 'error' | 'warning',
          message,
        });
      }
    }
    return errors;
  }
}

// Singleton instance
let executorInstance: TypeScriptExecutor | null = null;

/**
 * Get the singleton TypeScriptExecutor instance
 */
export function getTypeScriptExecutor(): TypeScriptExecutor {
  if (!executorInstance) {
    executorInstance = new TypeScriptExecutor();
  }
  return executorInstance;
}
