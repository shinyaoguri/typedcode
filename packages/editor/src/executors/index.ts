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

// C++ Executor
export { CppExecutor, getCppExecutor } from './cpp/CppExecutor.js';

// JavaScript Executor
export { JavaScriptExecutor, getJavaScriptExecutor } from './javascript/JavaScriptExecutor.js';

// TypeScript Executor
export { TypeScriptExecutor, getTypeScriptExecutor } from './typescript/TypeScriptExecutor.js';

// Python Executor
export { PythonExecutor, getPythonExecutor } from './python/PythonExecutor.js';

// Initialize registry with available executors
import { ExecutorRegistry } from './registry/ExecutorRegistry.js';
import { CExecutor } from './c/CExecutor.js';
import { CppExecutor } from './cpp/CppExecutor.js';
import { JavaScriptExecutor } from './javascript/JavaScriptExecutor.js';
import { TypeScriptExecutor } from './typescript/TypeScriptExecutor.js';
import { PythonExecutor } from './python/PythonExecutor.js';

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

// Register C++ executor
ExecutorRegistry.register('cpp', () => new CppExecutor(), {
  id: 'cpp',
  name: 'C++',
  fileExtension: '.cpp',
  monacoLanguage: 'cpp',
  defaultCode: `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`,
});

// Register JavaScript executor
ExecutorRegistry.register('javascript', () => new JavaScriptExecutor(), {
  id: 'javascript',
  name: 'JavaScript',
  fileExtension: '.js',
  monacoLanguage: 'javascript',
  defaultCode: `// Welcome to JavaScript!
console.log("Hello, World!");
`,
});

// Register TypeScript executor
ExecutorRegistry.register('typescript', () => new TypeScriptExecutor(), {
  id: 'typescript',
  name: 'TypeScript',
  fileExtension: '.ts',
  monacoLanguage: 'typescript',
  defaultCode: `// Welcome to TypeScript!
const message: string = "Hello, World!";
console.log(message);
`,
});

// Register Python executor
ExecutorRegistry.register('python', () => new PythonExecutor(), {
  id: 'python',
  name: 'Python',
  fileExtension: '.py',
  monacoLanguage: 'python',
  defaultCode: `# Welcome to Python!
print("Hello, World!")
`,
});
