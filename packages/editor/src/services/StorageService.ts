/**
 * Storage Service
 *
 * Provides utilities for working with localStorage with type safety and error handling.
 */

export interface StorageOptions {
  /** Key prefix for namespacing (default: 'typedcode-') */
  prefix?: string;
}

export class StorageService {
  private readonly prefix: string;

  constructor(options: StorageOptions = {}) {
    this.prefix = options.prefix ?? 'typedcode-';
  }

  /**
   * Get a value from storage
   */
  get<T>(key: string, defaultValue?: T): T | undefined {
    try {
      const item = localStorage.getItem(this.prefix + key);
      if (item === null) return defaultValue;
      return JSON.parse(item) as T;
    } catch {
      console.warn(`[StorageService] Failed to parse ${key}`);
      return defaultValue;
    }
  }

  /**
   * Set a value in storage
   */
  set<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`[StorageService] Failed to save ${key}:`, error);
      return false;
    }
  }

  /**
   * Remove a value from storage
   */
  remove(key: string): void {
    localStorage.removeItem(this.prefix + key);
  }

  /**
   * Check if a key exists in storage
   */
  has(key: string): boolean {
    return localStorage.getItem(this.prefix + key) !== null;
  }

  /**
   * Clear all items with this service's prefix
   */
  clear(): void {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }
}

// Singleton instance
let instance: StorageService | null = null;

/**
 * Get the singleton StorageService instance
 */
export function getStorageService(): StorageService {
  if (!instance) {
    instance = new StorageService();
  }
  return instance;
}
