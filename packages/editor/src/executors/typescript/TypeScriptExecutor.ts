/**
 * TypeScript Language Executor
 *
 * Transpiles TypeScript code to JavaScript and executes it using JavaScriptExecutor.
 * Uses the TypeScript compiler API for transpilation (no type checking for performance).
 */

import * as ts from 'typescript';
import { BaseExecutor } from '../base/BaseExecutor.js';
import { getJavaScriptExecutor } from '../javascript/JavaScriptExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

const DEFAULT_TS_CODE = `// Welcome to TypeScript!
const message: string = "Hello, World!";
console.log(message);

// Example with types
interface User {
  name: string;
  age: number;
}

const user: User = { name: "Alice", age: 30 };
console.log(\`User: \${user.name}, Age: \${user.age}\`);
`;

export class TypeScriptExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'typescript',
    name: 'TypeScript',
    fileExtension: '.ts',
    monacoLanguage: 'typescript',
    defaultCode: DEFAULT_TS_CODE,
  };

  protected async _doInitialize(
    onProgress?: (progress: InitializationProgress) => void
  ): Promise<void> {
    // TypeScript compiler is immediately available
    onProgress?.({
      stage: 'ready',
      message: 'TypeScript compiler ready!',
      percentage: 100,
    });
  }

  async run(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    if (!this._initialized) {
      throw new Error('TypeScriptExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();

    try {
      callbacks.onProgress?.('Transpiling TypeScript...');

      // Transpile TypeScript to JavaScript
      const result = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2020,
          strict: false, // Lenient for runtime execution
          esModuleInterop: true,
          skipLibCheck: true,
        },
        reportDiagnostics: true,
      });

      // Report compilation errors if any
      if (result.diagnostics && result.diagnostics.length > 0) {
        const errorDiagnostics = result.diagnostics.filter(
          (d) => d.category === ts.DiagnosticCategory.Error
        );

        if (errorDiagnostics.length > 0) {
          const errors = errorDiagnostics
            .map((d) => {
              const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
              if (d.file && d.start !== undefined) {
                const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
                return `(${line + 1},${character + 1}): error TS${d.code}: ${message}`;
              }
              return `error TS${d.code}: ${message}`;
            })
            .join('\n');

          callbacks.onStderr(errors + '\n');
          return {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: errors,
            error: 'TypeScript compilation failed',
          };
        }
      }

      callbacks.onProgress?.('Running JavaScript...');

      // Execute using JavaScriptExecutor
      const jsExecutor = getJavaScriptExecutor();
      if (!jsExecutor.isInitialized) {
        await jsExecutor.initialize();
      }

      return await jsExecutor.run(result.outputText, callbacks);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      callbacks.onStderr(`TypeScript Error: ${errorMsg}\n`);
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
    // Delegate to JavaScriptExecutor's abort
    getJavaScriptExecutor().abort();
  }

  parseErrors(stderr: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // TypeScript error format: "(line,column): error TS1234: message"
    const regex = /\((\d+),(\d+)\):\s*(error|warning)\s*TS\d+:\s*(.+)/g;

    let match;
    while ((match = regex.exec(stderr)) !== null) {
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
