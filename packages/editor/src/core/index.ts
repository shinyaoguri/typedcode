/**
 * Core Module
 *
 * Provides core functionality for the editor application.
 */

// Re-export from submodules as they are created
// Currently a placeholder for future modules

/**
 * Runtime Status types for language executors
 */
export type RuntimeState = 'not-ready' | 'loading' | 'ready';

export interface RuntimeStatus {
  c: RuntimeState;
  // Future: python, javascript, etc.
}

/**
 * Default runtime status
 */
export function createDefaultRuntimeStatus(): RuntimeStatus {
  return {
    c: 'not-ready',
  };
}
