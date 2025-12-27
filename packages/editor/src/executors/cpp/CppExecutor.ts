/**
 * C++ Language Executor
 *
 * Extends CExecutor to compile and execute C++ code.
 * Uses the same Clang compiler with C++ specific options.
 */

import { CExecutor } from '../c/CExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
} from '../interfaces/ILanguageExecutor.js';

const DEFAULT_CPP_CODE = `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`;

export class CppExecutor extends CExecutor {
  override readonly config: ExecutorConfig = {
    id: 'cpp',
    name: 'C++',
    fileExtension: '.cpp',
    monacoLanguage: 'cpp',
    defaultCode: DEFAULT_CPP_CODE,
  };

  override async run(
    code: string,
    callbacks: ExecutionCallbacks
  ): Promise<ExecutionResult> {
    return this.runWithOptions(code, callbacks, {
      sourceFile: 'main.cpp',
      compileArgs: ['-xc++', '-std=c++17'],
    });
  }
}

// Singleton instance
let executorInstance: CppExecutor | null = null;

/**
 * Get the singleton CppExecutor instance
 */
export function getCppExecutor(): CppExecutor {
  if (!executorInstance) {
    executorInstance = new CppExecutor();
  }
  return executorInstance;
}
