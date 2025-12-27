/**
 * Executor Registry
 *
 * Central registry for managing language executors.
 * Uses the factory pattern to lazily instantiate executors on demand.
 */

import type {
  ILanguageExecutor,
  ExecutorConfig,
} from '../interfaces/ILanguageExecutor.js';

export type ExecutorFactory = () => ILanguageExecutor;

/**
 * Registry for language executors
 *
 * Usage:
 * ```typescript
 * // Register an executor factory
 * ExecutorRegistry.register('c', () => new CExecutor());
 *
 * // Get an executor instance
 * const executor = await ExecutorRegistry.get('c');
 *
 * // List all registered languages
 * const languages = ExecutorRegistry.getSupportedLanguages();
 * ```
 */
export class ExecutorRegistry {
  private static executors: Map<string, ILanguageExecutor> = new Map();
  private static factories: Map<string, ExecutorFactory> = new Map();
  private static configs: Map<string, ExecutorConfig> = new Map();

  /**
   * Register a language executor factory
   *
   * @param id - Unique language identifier (e.g., 'c', 'python')
   * @param factory - Factory function that creates a new executor instance
   * @param config - Optional executor configuration (for listing without instantiation)
   */
  static register(
    id: string,
    factory: ExecutorFactory,
    config?: ExecutorConfig
  ): void {
    this.factories.set(id, factory);
    if (config) {
      this.configs.set(id, config);
    }
  }

  /**
   * Get an executor by language ID
   * Creates a new instance if one doesn't exist
   *
   * @param id - Language identifier
   * @returns The executor instance
   * @throws Error if no executor is registered for the given ID
   */
  static get(id: string): ILanguageExecutor {
    // Return existing instance if available
    if (this.executors.has(id)) {
      return this.executors.get(id)!;
    }

    // Create new instance from factory
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`Unknown executor: ${id}. Available: ${Array.from(this.factories.keys()).join(', ')}`);
    }

    const executor = factory();
    this.executors.set(id, executor);

    // Store config if not already stored
    if (!this.configs.has(id)) {
      this.configs.set(id, executor.config);
    }

    return executor;
  }

  /**
   * Check if an executor is registered for the given language ID
   */
  static has(id: string): boolean {
    return this.factories.has(id);
  }

  /**
   * Get all registered language configurations
   * This does not instantiate executors - it returns stored configs
   */
  static getSupportedLanguages(): ExecutorConfig[] {
    const configs: ExecutorConfig[] = [];

    for (const [id, factory] of this.factories) {
      // Use stored config if available
      if (this.configs.has(id)) {
        configs.push(this.configs.get(id)!);
      } else {
        // Fallback: instantiate to get config (less efficient)
        const executor = this.get(id);
        configs.push(executor.config);
      }
    }

    return configs;
  }

  /**
   * Get the configuration for a specific language without instantiating
   */
  static getConfig(id: string): ExecutorConfig | undefined {
    // Return stored config if available
    if (this.configs.has(id)) {
      return this.configs.get(id);
    }

    // If executor already exists, get from it
    if (this.executors.has(id)) {
      return this.executors.get(id)!.config;
    }

    return undefined;
  }

  /**
   * Dispose all executor instances
   */
  static disposeAll(): void {
    for (const executor of this.executors.values()) {
      executor.dispose();
    }
    this.executors.clear();
  }

  /**
   * Dispose a specific executor
   */
  static dispose(id: string): void {
    const executor = this.executors.get(id);
    if (executor) {
      executor.dispose();
      this.executors.delete(id);
    }
  }

  /**
   * Clear all registrations (primarily for testing)
   */
  static clear(): void {
    this.disposeAll();
    this.factories.clear();
    this.configs.clear();
  }
}
