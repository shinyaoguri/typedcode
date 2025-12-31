/**
 * UIStateManager - Centralized UI state management
 * Tracks verification counts, filename counters, and current display state
 */

export interface UIState {
  completedCount: number;
  totalCount: number;
  currentDisplayedTabId: string | null;
}

export type UIStateChangeCallback = (state: UIState) => void;

export class UIStateManager {
  private completedCount = 0;
  private totalCount = 0;
  private currentDisplayedTabId: string | null = null;
  private filenameCounter: Map<string, number> = new Map();
  private onChangeCallback: UIStateChangeCallback | null = null;

  /**
   * Set callback for state changes
   */
  setOnChange(callback: UIStateChangeCallback): void {
    this.onChangeCallback = callback;
  }

  /**
   * Get current state
   */
  getState(): UIState {
    return {
      completedCount: this.completedCount,
      totalCount: this.totalCount,
      currentDisplayedTabId: this.currentDisplayedTabId,
    };
  }

  /**
   * Increment completed count
   */
  incrementCompleted(): void {
    this.completedCount++;
    this.notifyChange();
  }

  /**
   * Increment total count
   */
  incrementTotal(): void {
    this.totalCount++;
    this.notifyChange();
  }

  /**
   * Get current displayed tab ID
   */
  getCurrentDisplayedTabId(): string | null {
    return this.currentDisplayedTabId;
  }

  /**
   * Set current displayed tab ID
   */
  setCurrentDisplayedTabId(id: string | null): void {
    this.currentDisplayedTabId = id;
  }

  /**
   * Check if a specific tab is currently displayed
   */
  isDisplayed(id: string): boolean {
    return this.currentDisplayedTabId === id;
  }

  /**
   * Get next filename number for duplicate handling
   */
  getNextFilenameNumber(key: string): number {
    const count = this.filenameCounter.get(key) || 0;
    this.filenameCounter.set(key, count + 1);
    return count;
  }

  /**
   * Generate display name with duplicate handling
   * @param filename Original filename
   * @param folderId Folder ID (optional)
   */
  generateDisplayName(filename: string, folderId?: string): string {
    const key = folderId ? `${folderId}:${filename}` : filename;
    const count = this.getNextFilenameNumber(key);

    if (count > 0) {
      const ext = filename.match(/\.[^.]+$/)?.[0] || '';
      const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
      return `${nameWithoutExt} (${count + 1})${ext}`;
    }

    return filename;
  }

  /**
   * Generate folder name with duplicate handling
   */
  generateFolderName(baseName: string): string {
    const key = `folder:${baseName}`;
    const count = this.getNextFilenameNumber(key);

    if (count > 0) {
      return `${baseName} (${count + 1})`;
    }
    return baseName;
  }

  /**
   * Check if verification is in progress
   */
  isVerifying(): boolean {
    return this.completedCount < this.totalCount;
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.completedCount = 0;
    this.totalCount = 0;
    this.currentDisplayedTabId = null;
    this.filenameCounter.clear();
    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.onChangeCallback) {
      this.onChangeCallback(this.getState());
    }
  }
}
