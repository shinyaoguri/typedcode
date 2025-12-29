/**
 * VerifyTabManager - 検証ページのタブ状態管理
 * 複数ファイルの検証状態を管理し、タブ切り替えを制御する
 */

import type { VerifyTabState } from '../types.js';

export type TabChangeCallback = (tab: VerifyTabState, prevTab: VerifyTabState | null) => void;
export type TabUpdateCallback = (tab: VerifyTabState) => void;

export class VerifyTabManager {
  private tabs: Map<string, VerifyTabState> = new Map();
  private activeTabId: string | null = null;
  private tabOrder: string[] = [];  // タブの表示順序を保持

  private onChangeCallback: TabChangeCallback | null = null;
  private onUpdateCallback: TabUpdateCallback | null = null;

  /**
   * タブを追加
   */
  addTab(state: VerifyTabState): void {
    this.tabs.set(state.id, state);
    this.tabOrder.push(state.id);

    // 最初のタブの場合はアクティブにする
    if (this.activeTabId === null) {
      this.activeTabId = state.id;
      this.onChangeCallback?.(state, null);
    }

    this.onUpdateCallback?.(state);
  }

  /**
   * タブを更新
   */
  updateTab(id: string, updates: Partial<VerifyTabState>): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const updated = { ...tab, ...updates };
    this.tabs.set(id, updated);

    this.onUpdateCallback?.(updated);

    // アクティブタブが更新された場合はonChangeも呼ぶ
    if (id === this.activeTabId) {
      this.onChangeCallback?.(updated, tab);
    }
  }

  /**
   * タブを削除
   */
  removeTab(id: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;

    this.tabs.delete(id);
    const orderIndex = this.tabOrder.indexOf(id);
    if (orderIndex >= 0) {
      this.tabOrder.splice(orderIndex, 1);
    }

    // アクティブタブが削除された場合は別のタブに切り替え
    if (this.activeTabId === id) {
      const nextTabId = this.tabOrder[Math.max(0, orderIndex - 1)] ?? null;
      if (nextTabId) {
        this.switchTab(nextTabId);
      } else {
        this.activeTabId = null;
      }
    }

    return true;
  }

  /**
   * タブを切り替え
   */
  switchTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const prevTab = this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
    this.activeTabId = id;

    this.onChangeCallback?.(tab, prevTab);
  }

  /**
   * アクティブなタブを取得
   */
  getActiveTab(): VerifyTabState | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /**
   * 指定IDのタブを取得
   */
  getTab(id: string): VerifyTabState | null {
    return this.tabs.get(id) ?? null;
  }

  /**
   * 全タブを取得（表示順）
   */
  getAllTabs(): VerifyTabState[] {
    return this.tabOrder
      .map(id => this.tabs.get(id))
      .filter((tab): tab is VerifyTabState => tab !== undefined);
  }

  /**
   * タブ数を取得
   */
  getTabCount(): number {
    return this.tabs.size;
  }

  /**
   * タブが存在するかチェック
   */
  hasTab(id: string): boolean {
    return this.tabs.has(id);
  }

  /**
   * 全タブをクリア
   */
  clear(): void {
    this.tabs.clear();
    this.tabOrder = [];
    this.activeTabId = null;
  }

  /**
   * タブ切り替えコールバックを設定
   */
  setOnChange(callback: TabChangeCallback): void {
    this.onChangeCallback = callback;
  }

  /**
   * タブ更新コールバックを設定
   */
  setOnUpdate(callback: TabUpdateCallback): void {
    this.onUpdateCallback = callback;
  }

  /**
   * アクティブタブIDを取得
   */
  getActiveTabId(): string | null {
    return this.activeTabId;
  }
}
