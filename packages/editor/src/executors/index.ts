/**
 * Executors Module
 *
 * Provides the language executor system for running code in the browser.
 */

// Interfaces
export type {
  ILanguageExecutor,
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from './interfaces/ILanguageExecutor.js';

// Base class
export { BaseExecutor } from './base/BaseExecutor.js';

// Registry
export { ExecutorRegistry } from './registry/ExecutorRegistry.js';
export type { ExecutorFactory } from './registry/ExecutorRegistry.js';

// C Executor
export { CExecutor, getCExecutor } from './c/CExecutor.js';

// Initialize registry with available executors
import { ExecutorRegistry } from './registry/ExecutorRegistry.js';
import { CExecutor } from './c/CExecutor.js';

// Register C executor
ExecutorRegistry.register('c', () => new CExecutor(), {
  id: 'c',
  name: 'C',
  fileExtension: '.c',
  monacoLanguage: 'c',
  defaultCode: `#include <stdio.h>

int main() {
    printf("Hello, World!\\n");
    return 0;
}
`,
  icon: 'c-icon',
});
