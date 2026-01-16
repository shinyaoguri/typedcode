/**
 * UIStateManager - 検証進捗状態管理
 *
 * 検証の進捗（完了数/総数）を一元管理
 * 表示タブIDは VerifyTabManager に委譲
 * ファイル名生成は FileNameGenerator に委譲
 */

import { FileNameGenerator } from './FileNameGenerator.js';

export interface UIState {
  completedCount: number;
  totalCount: number;
  /** @deprecated Use VerifyTabManager.getActiveTabId() instead */
  currentDisplayedTabId: string | null;
  /** @deprecated Use VerifyTabManager.getActiveTab()?.status instead */
  currentDisplayedTabStatus: string | null;
}

export type UIStateChangeCallback = (state: UIState) => void;

export class UIStateManager {
  private completedCount = 0;
  private totalCount = 0;
  private onChangeCallback: UIStateChangeCallback | null = null;
  private fileNameGenerator: FileNameGenerator;

  // 後方互換性のため維持（VerifyTabManager への移行を推奨）
  private currentDisplayedTabId: string | null = null;
  private currentDisplayedTabStatus: string | null = null;

  constructor() {
    this.fileNameGenerator = new FileNameGenerator();
  }

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
      currentDisplayedTabStatus: this.currentDisplayedTabStatus,
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
   * @deprecated Use VerifyTabManager.getActiveTabId() instead
   */
  getCurrentDisplayedTabId(): string | null {
    return this.currentDisplayedTabId;
  }

  /**
   * Set current displayed tab ID and status
   * @deprecated Use VerifyTabManager.switchTab() instead
   */
  setCurrentDisplayedTabId(id: string | null, status?: string | null): void {
    this.currentDisplayedTabId = id;
    this.currentDisplayedTabStatus = status ?? null;
  }

  /**
   * Get current displayed tab status
   * @deprecated Use VerifyTabManager.getActiveTab()?.status instead
   */
  getCurrentDisplayedTabStatus(): string | null {
    return this.currentDisplayedTabStatus;
  }

  /**
   * Check if a specific tab is currently displayed
   * @deprecated Use VerifyTabManager.getActiveTabId() === id instead
   */
  isDisplayed(id: string): boolean {
    return this.currentDisplayedTabId === id;
  }

  /**
   * Get next filename number for duplicate handling
   * @deprecated Use FileNameGenerator.getNextNumber() instead
   */
  getNextFilenameNumber(key: string): number {
    return this.fileNameGenerator.getNextNumber(key);
  }

  /**
   * Generate display name with duplicate handling
   */
  generateDisplayName(filename: string, folderId?: string): string {
    return this.fileNameGenerator.generateDisplayName(filename, folderId);
  }

  /**
   * Generate folder name with duplicate handling
   */
  generateFolderName(baseName: string): string {
    return this.fileNameGenerator.generateFolderName(baseName);
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
    this.currentDisplayedTabStatus = null;
    this.fileNameGenerator.reset();
    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.onChangeCallback) {
      this.onChangeCallback(this.getState());
    }
  }
}
